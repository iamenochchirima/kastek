import { createProductHttpAdapterManifest } from "@kasitek-labs/contracts";
import { requestDigest } from "../../contracts/contracts";
import type { ProductAdapterInstallation } from "../../contracts/products";
import { ProductActionClient } from "./product-action-client";

const installed = createProductHttpAdapterManifest("agencies", "1", requestDigest);
const installations = new WeakMap<ProductAdapterInstallation, string>();
/** Installs transport only. A product composition still needs a destination-issued mapping and grant. */
export function registerAgencyProductCapabilities(runtime: ProductAdapterInstallation, env: NodeJS.ProcessEnv = process.env): boolean {
  const origin = env.AGENCY_PRODUCT_API_URL;
  const privateKey = env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY;
  if (!origin || !privateKey) return false;
  const options = { origin, privateKey: privateKey.replace(/\\n/g, "\n"),
    issuer: env.AGENTS_PRODUCT_ACTION_ISSUER ?? "https://agents.kasitek.co.za",
    keyId: env.AGENTS_PRODUCT_ACTION_KEY_ID ?? "agents-v1", environment: env.NODE_ENV ?? "development" };
  const configuration = requestDigest(options);
  const installedConfiguration = installations.get(runtime);
  if (installedConfiguration && installedConfiguration !== configuration) throw Error("Agency capability service configuration changed within the installed adapter release");
  if (!installedConfiguration) {
    const client = new ProductActionClient(options);
    runtime.registerAdapter(installed, { handlers: ["agency.workspace-agent-metadata@1"],
      invoke: (command, signal) => client.invoke(command, signal) });
    installations.set(runtime, configuration);
  }
  return true;
}
