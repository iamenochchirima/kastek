# Build from the monorepo root; runtime configuration remains in Railway variables.
FROM quay.io/keycloak/keycloak:26.6.4 AS keycloak

FROM eclipse-temurin:21.0.9_10-jdk AS email-provider
COPY --from=keycloak /opt/keycloak/lib/ /opt/keycloak/lib/
COPY infra/identity/email-provider/ /src/email-provider/
RUN KEYCLOAK_HOME=/opt/keycloak IDENTITY_PROVIDER_BUILD_DIR=/build \
    bash /src/email-provider/build.sh

FROM keycloak AS build
COPY --from=email-provider /build/kasitek-resend-email.jar /opt/keycloak/providers/
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true \
    KC_HTTP_MANAGEMENT_HEALTH_ENABLED=false
RUN /opt/keycloak/bin/kc.sh build --spi-email-sender--provider=resend

FROM keycloak
COPY --from=build /opt/keycloak/ /opt/keycloak/
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true \
    KC_HTTP_ENABLED=true KC_PROXY_HEADERS=xforwarded KC_HOSTNAME_STRICT=true \
    KC_HTTP_MANAGEMENT_HEALTH_ENABLED=false
EXPOSE 8080
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized"]
