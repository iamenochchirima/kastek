package za.co.kasitek.identity;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.http.HttpClient;
import java.net.InetSocketAddress;
import java.net.URI;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import com.sun.net.httpserver.HttpServer;
import java.net.http.HttpRequest;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;
import java.util.concurrent.atomic.AtomicInteger;

import org.keycloak.email.EmailException;
import org.keycloak.util.JsonSerialization;

public final class ResendEmailSenderProviderTest {
    private static int passed;
    private static final Map<String, String> CONFIG = Map.of("from", "noreply@example.com",
            "fromDisplayName", "KasiTek \"Identity\"", "replyTo", "help@example.com");

    interface Check { void run() throws Exception; }

    private static void test(String name, Check check) throws Exception {
        check.run();
        passed++;
        System.out.println("PASS " + name);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void fails(Check check, String expected) throws Exception {
        try {
            check.run();
            throw new AssertionError("Expected EmailException");
        } catch (EmailException error) {
            require(error.getMessage().equals(expected), "Unsafe or incorrect error: " + error.getMessage());
            require(error.getCause() == null, "Sensitive provider failure retained as cause");
        }
    }

    private static String body(HttpRequest request) throws Exception {
        var completed = new CompletableFuture<String>();
        var output = new ByteArrayOutputStream();
        request.bodyPublisher().orElseThrow().subscribe(new Flow.Subscriber<ByteBuffer>() {
            public void onSubscribe(Flow.Subscription subscription) { subscription.request(Long.MAX_VALUE); }
            public void onNext(ByteBuffer chunk) {
                byte[] bytes = new byte[chunk.remaining()];
                chunk.get(bytes);
                output.writeBytes(bytes);
            }
            public void onError(Throwable failure) { completed.completeExceptionally(failure); }
            public void onComplete() { completed.complete(output.toString(StandardCharsets.UTF_8)); }
        });
        return completed.get();
    }

    private static void send(ResendEmailSenderProvider provider) throws EmailException {
        provider.send(CONFIG, "owner@example.com", "Verify your email", "Verification link", "<a>Verification</a>");
    }

    public static void main(String[] args) throws Exception {
        test("template content, sender, recipient and reply-to survive HTTPS encoding", () -> {
            var provider = new ResendEmailSenderProvider("test-key", request -> {
                try {
                    require(request.uri().equals(ResendEmailSenderProvider.ENDPOINT), "Wrong destination");
                    require(request.method().equals("POST"), "Wrong method");
                    require(request.timeout().orElseThrow().equals(Duration.ofSeconds(10)), "Request not bounded");
                    require(request.headers().firstValue("Authorization").orElseThrow().equals("Bearer test-key"), "Missing authentication");
                    require(request.headers().firstValue("Content-Type").orElseThrow().equals("application/json"), "Missing content type");
                    Map<?, ?> payload = JsonSerialization.readValue(body(request), Map.class);
                    require(payload.get("from").equals("\"KasiTek \\\"Identity\\\"\" <noreply@example.com>"), "Sender changed");
                    require(payload.get("to").equals(java.util.List.of("owner@example.com")), "Recipient changed");
                    require(payload.get("reply_to").equals("help@example.com"), "Reply-to changed");
                    require(payload.get("text").equals("Verification link"), "Text changed");
                    require(payload.get("html").equals("<a>Verification</a>"), "HTML changed");
                    require(payload.get("subject").equals("Verify your email"), "Subject changed");
                } catch (Exception error) { throw new AssertionError(error); }
                return new ResendEmailSenderProvider.Response(200, "{\"id\":\"delivery-1\"}");
            });
            send(provider);
        });
        test("TLS client refuses redirects and bounds connection time", () -> {
            try (var client = ResendEmailSenderProvider.newClient()) {
                require(client.followRedirects() == HttpClient.Redirect.NEVER, "Redirects enabled");
                require(client.connectTimeout().orElseThrow().equals(Duration.ofSeconds(5)), "Connection not bounded");
            }
        });
        test("provider rejection is sanitized and is not retried", () -> {
            var calls = new AtomicInteger();
            var provider = new ResendEmailSenderProvider("test-key", request -> {
                calls.incrementAndGet();
                return new ResendEmailSenderProvider.Response(403, "secret owner@example.com action-token");
            });
            fails(() -> send(provider), "Resend HTTPS send rejected (status 403)");
            require(calls.get() == 1, "Delivery was retried");
        });
        test("timeout preserves uncertain outcome without retry", () -> {
            var calls = new AtomicInteger();
            var provider = new ResendEmailSenderProvider("test-key", request -> {
                calls.incrementAndGet(); throw new HttpTimeoutException("secret token");
            });
            fails(() -> send(provider), "Resend HTTPS request timed out");
            require(calls.get() == 1, "Delivery was retried");
        });
        test("transport errors omit secrets and nested causes", () -> fails(() -> send(
                new ResendEmailSenderProvider("test-key", request -> { throw new IOException("secret token"); })),
                "Resend HTTPS request failed"));
        test("interrupt cancels the request and preserves interrupt state", () -> {
            fails(() -> send(new ResendEmailSenderProvider("test-key", request -> { throw new InterruptedException("secret"); })),
                    "Resend HTTPS request interrupted");
            require(Thread.interrupted(), "Interrupt state lost");
        });
        test("malformed success response is not accepted", () -> fails(() -> send(
                new ResendEmailSenderProvider("test-key", request -> new ResendEmailSenderProvider.Response(200, "not JSON secret"))),
                "Resend HTTPS request failed"));
        test("success requires a provider delivery identifier", () -> fails(() -> send(
                new ResendEmailSenderProvider("test-key", request -> new ResendEmailSenderProvider.Response(200, "{}"))),
                "Resend HTTPS send returned no delivery identifier"));
        test("missing API key fails before network use", () -> fails(() -> send(
                new ResendEmailSenderProvider("", request -> { throw new AssertionError("Network called"); })),
                "Resend email configuration invalid: RESEND_API_KEY"));
        test("invalid sender fails before network use", () -> fails(() ->
                new ResendEmailSenderProvider("test-key", request -> { throw new AssertionError("Network called"); })
                        .validate(Map.of("from", "noreply@example.com\r\nBcc: secret@example.com")),
                "Resend email configuration invalid: from"));
        test("JSON null success response is rejected safely", () -> fails(() -> send(
                new ResendEmailSenderProvider("test-key", request -> new ResendEmailSenderProvider.Response(200, "null"))),
                "Resend HTTPS send returned no delivery identifier"));
        test("response body has a total deadline after headers arrive", () -> {
            var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            var release = new CountDownLatch(1);
            var threads = Executors.newCachedThreadPool();
            server.setExecutor(threads);
            server.createContext("/", exchange -> {
                try {
                    exchange.sendResponseHeaders(200, 100);
                    exchange.getResponseBody().write('{');
                    exchange.getResponseBody().flush();
                    release.await();
                } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                finally { exchange.close(); }
            });
            server.start();
            try (var client = ResendEmailSenderProvider.newClient()) {
                long start = System.nanoTime();
                var transport = ResendEmailSenderProvider.transport(client, Duration.ofMillis(300));
                try {
                    transport.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/"))
                            .timeout(Duration.ofSeconds(5)).GET().build());
                    throw new AssertionError("Stalled body accepted");
                } catch (HttpTimeoutException expected) {
                    require(Duration.ofNanos(System.nanoTime() - start).toMillis() < 2000, "Total deadline exceeded");
                }
            } finally {
                release.countDown();
                server.stop(0);
                threads.shutdownNow();
            }
        });
        test("oversized response body is refused", () -> {
            var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                byte[] content = new byte[65537];
                try {
                    exchange.sendResponseHeaders(200, content.length);
                    exchange.getResponseBody().write(content);
                } finally { exchange.close(); }
            });
            server.start();
            try (var client = ResendEmailSenderProvider.newClient()) {
                try {
                    ResendEmailSenderProvider.transport(client).send(HttpRequest.newBuilder(
                            URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/")).GET().build());
                    throw new AssertionError("Oversized body accepted");
                } catch (IOException expected) {
                    require(expected.getMessage().equals("Email response failed"), "Unsafe transport error");
                }
            } finally { server.stop(0); }
        });
        System.out.println("Passed " + passed + " HTTPS email provider checks; no network messages sent.");
    }
}
