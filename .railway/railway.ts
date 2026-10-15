import { defineRailway, github, project, service } from "railway/iac";

// This repository owns the Collector partial, not the rest of the shared Railway project.
export const partial = "otel-collector";

export default defineRailway((context) => {
  if (
    context.projectName !== "KasiTek Staging" ||
    !context.isEnvironment("staging")
  ) {
    throw new Error(
      'The Collector partial may only target the "staging" environment in the KasiTek Staging project.',
    );
  }

  const collector = service("otel-collector", {
    source: github("Kasitek-Labs/kastek", {
      branch: "rewrite",
      rootDirectory: "infra/observability/otel-collector",
    }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
    },
    start: "/otelcol-contrib --config=/etc/otelcol/config.staging.yaml",
    healthcheck: "/",
    healthcheckTimeout: 30,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
  });

  return project("KasiTek Staging", { resources: [collector] });
});
