import type { GrowthAgentPublication } from "@kasitek-labs/contracts";
import { growthAgentPublicationV11 } from "./retained-publication-v11.js";
// Preserve the exact pre-consolidation publication from immutable revision11.
export const growthAgentPublicationV12: GrowthAgentPublication = {
 ...growthAgentPublicationV11,
 manifest:{...growthAgentPublicationV11.manifest,revision:"12",adapter:{"id":"growth-product","release":"9","manifestDigest":"25a8521c1b1e8e09d542dc14493bc600b26ce968b7e28fd33afbe964d4fbcaf5"},digest:"763dcea82211fa23c69d0309325f785bc759576a5dff8affedc56ff7617b6533"},
 policy:{"revision":"12","optionalCapabilities":{"knowledge":true,"skills":true,"memory":true,"delegation":true,"sandbox":false,"workflows":false,"connections":false},"delegation":{"maxChildren":2,"maxDepth":null,"policy":{"maxTasks":null,"maxStalls":3},"childLimits":{"maxTokens":null,"maxActiveMs":null},"delegates":{"assistant":["research","content","campaigns"],"research":[],"content":["research"],"campaigns":["research"]}}}
};
