# Build from the monorepo root; runtime configuration remains in Railway variables.
FROM quay.io/keycloak/keycloak:26.6.0 AS build
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true \
    KC_HTTP_MANAGEMENT_HEALTH_ENABLED=false
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.6.0
COPY --from=build /opt/keycloak/ /opt/keycloak/
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true \
    KC_HTTP_ENABLED=true KC_PROXY_HEADERS=xforwarded KC_HOSTNAME_STRICT=true \
    KC_HTTP_MANAGEMENT_HEALTH_ENABLED=false
EXPOSE 8080
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized"]
