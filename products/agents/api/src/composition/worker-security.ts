export interface WorkerSecurity { host: string; identityKeys: string[] | undefined }
export function workerSecurityFromEnvironment(environment: NodeJS.ProcessEnv = process.env): WorkerSecurity {
  const mode = environment.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(mode)) throw new Error("Invalid worker environment");
  const host = environment.RESTATE_WORKER_HOST?.trim() || "127.0.0.1";
  const identityKeys = environment.RESTATE_REQUEST_IDENTITY_KEYS?.split(",").map(key => key.trim()).filter(Boolean);
  if (identityKeys?.some(key => !/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(key)) || (identityKeys?.length ?? 0) > 8) throw new Error("Invalid Restate request identity keys");
  const signed = Boolean(identityKeys?.length);
  if (mode === "production" && !signed) throw new Error("Production workers require Restate request identity keys");
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !signed && environment.AGENTS_ALLOW_UNSIGNED_WORKER !== "1") {
    throw new Error("Unsigned workers require loopback binding or explicit development opt-in");
  }
  return { host, identityKeys: signed ? identityKeys : undefined };
}
