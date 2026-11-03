import type { Pool } from "pg";
import { growthActionClientFromEnvironment } from "../../adapters/products/growth-action-client";
import { registerAgencyProductCapabilities } from "../../adapters/products/agency-capability-client";
import { EvidenceStore } from "../context/evidence";
import { ProductRuntime } from "./product-runtime";
import { GrowthProductRuntime } from "./growth-runtime";
import { registerAgencyOriginAuthority } from "./agency-runtime";

export async function createConfiguredProductRuntime(pool:Pool,evidence:EvidenceStore,env:NodeJS.ProcessEnv=process.env):Promise<ProductRuntime|undefined> {
  const growth=env.GROWTH_PRODUCT_API_URL?growthActionClientFromEnvironment(env):undefined;
  if(!growth&&!env.AGENCY_PRODUCT_API_URL)return;
  const runtime=growth?new GrowthProductRuntime(pool,growth,evidence):new ProductRuntime(pool,evidence);
  if(runtime instanceof GrowthProductRuntime)await runtime.loadPublications();
  registerAgencyProductCapabilities(runtime,env);
  registerAgencyOriginAuthority(runtime,env);
  return runtime;
}
