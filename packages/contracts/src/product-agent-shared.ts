/**
 * Product-neutral agent projections shared by product backends.
 *
 * The definitions currently live in the Growth contract while Growth is the first consumer.
 * Re-exporting here gives Agencies and later products a stable import boundary, so the
 * definitions can move without another consumer change.
 */
export type {
  GrowthAgentTask as ProductAgentTask,
  GrowthAgentObservation as ProductAgentObservation,
  GrowthAgentMessage as ProductAgentMessage,
  GrowthAgentConversation as ProductAgentConversation,
  GrowthAgentTaskState as ProductAgentTaskState,
} from "./growth-agents.js";
