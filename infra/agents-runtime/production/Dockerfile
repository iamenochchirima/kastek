# Build from the repository root. The local compose profile remains independent.
FROM docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742
COPY infra/agents-runtime/production/entrypoint.sh /usr/local/bin/kasitek-restate-entrypoint
COPY infra/agents-runtime/production/restate.toml /etc/kasitek-restate/restate.toml
RUN chmod 0555 /usr/local/bin/kasitek-restate-entrypoint
EXPOSE 8080 9070
ENTRYPOINT ["/usr/local/bin/kasitek-restate-entrypoint"]
