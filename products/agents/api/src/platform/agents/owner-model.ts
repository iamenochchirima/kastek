import { PlatformError } from "../../contracts/contracts";

export interface OwnerModelInitializationPorts {
  initialize?(input: { accountId: string; organizationId: string }): Promise<unknown>;
  warn(event: Record<string, unknown>, message: string): void;
}

/** Managed default-model setup is best effort; the workspace remains usable without it. */
export async function initializeOwnerModel(options: OwnerModelInitializationPorts, accountId: string, organizationId: string): Promise<void> {
  try { await options.initialize?.({ accountId, organizationId }); }
  catch (error) {
    options.warn({ event: "agents.default_model.initialization_failed", organizationId,
      code: error instanceof PlatformError ? error.code : "MODEL_DEFAULT_UNAVAILABLE" }, "Managed model initialization unavailable");
  }
}
