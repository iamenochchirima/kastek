import { discoverProviderModels } from "./discovery";
import { callProviderModel } from "./pi-transport";
import { prepareInputCount, countPreparedInput } from "./input-count";

export interface ModelProviderAdapter {
  discover: typeof discoverProviderModels;
  invoke: typeof callProviderModel;
  prepareInputCount: typeof prepareInputCount;
  countInput: typeof countPreparedInput;
}

export const modelProviderAdapter: Readonly<ModelProviderAdapter> = Object.freeze({
  discover: discoverProviderModels,
  invoke: callProviderModel,
  prepareInputCount,
  countInput: countPreparedInput,
});
