import { AgentMessageContent } from "@kasitek-labs/ui/agent";

export function MessageContent({ text }: { text: string }) {
  return <AgentMessageContent text={text} />;
}
