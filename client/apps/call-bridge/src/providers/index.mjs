import { createManualProvider } from "./manual.mjs";
import { createMetaCloudApiProvider } from "./meta-cloud-api.mjs";

export function createProviderAdapter(context) {
  switch (context.provider) {
    case "meta":
    case "meta-cloud-api":
    case "whatsapp-meta":
      return createMetaCloudApiProvider(context);
    case "manual":
    case "stub":
    case "webrtc":
      return createManualProvider(context);
    default:
      return createManualProvider(context);
  }
}
