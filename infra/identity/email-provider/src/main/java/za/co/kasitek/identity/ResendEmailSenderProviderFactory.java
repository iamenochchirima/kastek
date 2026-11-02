package za.co.kasitek.identity;

import java.net.http.HttpClient;

import org.keycloak.Config;
import org.keycloak.email.EmailSenderProvider;
import org.keycloak.email.EmailSenderProviderFactory;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;

public final class ResendEmailSenderProviderFactory implements EmailSenderProviderFactory {
    private String apiKey;
    private HttpClient client;
    private ResendEmailSenderProvider.Transport transport;

    @Override
    public void init(Config.Scope config) {
        apiKey = System.getenv("RESEND_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException("Identity requires RESEND_API_KEY for HTTPS email");
        }
        client = ResendEmailSenderProvider.newClient();
        transport = ResendEmailSenderProvider.transport(client);
    }

    @Override
    public EmailSenderProvider create(KeycloakSession session) {
        return new ResendEmailSenderProvider(apiKey, transport);
    }

    @Override
    public String getId() { return "resend"; }

    @Override
    public void postInit(KeycloakSessionFactory factory) {}

    @Override
    public void close() {
        if (client != null) client.close();
        client = null;
        apiKey = null;
        transport = null;
    }
}
