package za.co.kasitek.identity;

import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import jakarta.mail.internet.InternetAddress;
import org.keycloak.email.EmailException;
import org.keycloak.email.EmailSenderProvider;
import org.keycloak.util.JsonSerialization;

public final class ResendEmailSenderProvider implements EmailSenderProvider {
    static final URI ENDPOINT = URI.create("https://api.resend.com/emails");
    private static final int MAX_RESPONSE_BYTES = 65536;
    private final String apiKey;
    private final Transport transport;

    interface Transport {
        Response send(HttpRequest request) throws IOException, InterruptedException;
    }

    record Response(int status, String body) {}

    static HttpClient newClient() {
        return HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5))
                .followRedirects(HttpClient.Redirect.NEVER).build();
    }

    static Transport transport(HttpClient client) {
        return transport(client, Duration.ofSeconds(10));
    }

    static Transport transport(HttpClient client, Duration deadline) {
        return request -> {
            var pending = client.sendAsync(request, ignored -> new LimitedBodySubscriber());
            try {
                var response = pending.get(deadline.toMillis(), TimeUnit.MILLISECONDS);
                return new Response(response.statusCode(), response.body());
            } catch (TimeoutException ignored) {
                pending.cancel(true);
                throw new HttpTimeoutException("Email request deadline exceeded");
            } catch (InterruptedException interrupted) {
                pending.cancel(true);
                throw interrupted;
            } catch (ExecutionException failed) {
                if (failed.getCause() instanceof HttpTimeoutException timeout) throw timeout;
                throw new IOException("Email response failed");
            }
        };
    }

    private static final class LimitedBodySubscriber implements HttpResponse.BodySubscriber<String> {
        private final CompletableFuture<String> result = new CompletableFuture<>();
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private Flow.Subscription subscription;

        @Override
        public CompletionStage<String> getBody() { return result; }

        @Override
        public void onSubscribe(Flow.Subscription incoming) {
            subscription = incoming;
            subscription.request(1);
        }

        @Override
        public void onNext(List<ByteBuffer> chunks) {
            for (var chunk : chunks) {
                if (chunk.remaining() > MAX_RESPONSE_BYTES - bytes.size()) {
                    subscription.cancel();
                    result.completeExceptionally(new IOException("Email response exceeded limit"));
                    return;
                }
                byte[] part = new byte[chunk.remaining()];
                chunk.get(part);
                bytes.writeBytes(part);
            }
            subscription.request(1);
        }

        @Override
        public void onError(Throwable failure) { result.completeExceptionally(failure); }

        @Override
        public void onComplete() { result.complete(bytes.toString(StandardCharsets.UTF_8)); }
    }

    ResendEmailSenderProvider(String apiKey, Transport transport) {
        this.apiKey = apiKey;
        this.transport = transport;
    }

    private static String required(String value, String name) throws EmailException {
        if (value == null || value.isBlank() || value.contains("\r") || value.contains("\n")) {
            throw new EmailException("Resend email configuration invalid: " + name);
        }
        return value;
    }

    private static String mailbox(String value, String name) throws EmailException {
        required(value, name);
        try {
            var address = new InternetAddress(value, true);
            address.validate();
            return address.getAddress();
        } catch (Exception ignored) {
            throw new EmailException("Resend email configuration invalid: " + name);
        }
    }

    @Override
    public void validate(Map<String, String> config) throws EmailException {
        required(apiKey, "RESEND_API_KEY");
        if (config == null) {
            throw new EmailException("Resend email configuration missing");
        }
        mailbox(config.get("from"), "from");
        if (config.get("fromDisplayName") != null && !config.get("fromDisplayName").isBlank()) {
            required(config.get("fromDisplayName"), "fromDisplayName");
        }
        if (config.get("replyTo") != null && !config.get("replyTo").isBlank()) {
            mailbox(config.get("replyTo"), "replyTo");
        }
        if (config.get("replyToDisplayName") != null && !config.get("replyToDisplayName").isBlank()) {
            required(config.get("replyToDisplayName"), "replyToDisplayName");
        }
    }

    @Override
    public void send(Map<String, String> config, String address, String subject,
                     String textBody, String htmlBody) throws EmailException {
        validate(config);
        String recipient = mailbox(address, "recipient");
        required(subject, "subject");
        if ((textBody == null || textBody.isBlank()) && (htmlBody == null || htmlBody.isBlank())) {
            throw new EmailException("Resend email content missing");
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        try {
            String from = mailbox(config.get("from"), "from");
            String displayName = config.get("fromDisplayName");
            payload.put("from", displayName == null || displayName.isBlank() ? from
                    : new InternetAddress(from, displayName, StandardCharsets.UTF_8.name()).toUnicodeString());
            payload.put("to", List.of(recipient));
            payload.put("subject", subject);
            if (textBody != null && !textBody.isBlank()) payload.put("text", textBody);
            if (htmlBody != null && !htmlBody.isBlank()) payload.put("html", htmlBody);
            String replyTo = config.get("replyTo");
            if (replyTo != null && !replyTo.isBlank()) {
                String replyAddress = mailbox(replyTo, "replyTo");
                String replyName = config.get("replyToDisplayName");
                payload.put("reply_to", replyName == null || replyName.isBlank() ? replyAddress
                        : new InternetAddress(replyAddress, replyName, StandardCharsets.UTF_8.name()).toUnicodeString());
            }
            var request = HttpRequest.newBuilder(ENDPOINT).timeout(Duration.ofSeconds(10))
                    .header("Authorization", "Bearer " + apiKey)
                    .header("Content-Type", "application/json")
                    .header("User-Agent", "KasiTek-Identity/1.0")
                    .POST(HttpRequest.BodyPublishers.ofString(JsonSerialization.writeValueAsString(payload)))
                    .build();
            // An uncertain send is left to the caller; automatic retries can duplicate verification email.
            Response response = transport.send(request);
            if (response.status() < 200 || response.status() >= 300) {
                throw new EmailException("Resend HTTPS send rejected (status " + response.status() + ")");
            }
            Map<?, ?> result = JsonSerialization.readValue(response.body(), Map.class);
            if (result == null || !(result.get("id") instanceof String id) || id.isBlank()) {
                throw new EmailException("Resend HTTPS send returned no delivery identifier");
            }
        } catch (HttpTimeoutException ignored) {
            throw new EmailException("Resend HTTPS request timed out");
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
            throw new EmailException("Resend HTTPS request interrupted");
        } catch (IOException | IllegalArgumentException ignored) {
            // Provider responses and exception messages can contain addresses, credentials or action URLs.
            throw new EmailException("Resend HTTPS request failed");
        }
    }

    @Override
    public void close() {}
}
