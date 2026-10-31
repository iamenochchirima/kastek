import { orchestrationContracts } from "../contracts/orchestration";

/** Model-only guidance; the recorded operation outcome and published tool contract stay unchanged. */
export function builtinObservationView(name: string, rawArguments: string, value: unknown): unknown {
  if (name !== "agents.discover") return value;
  let input: unknown;
  try { input = JSON.parse(rawArguments); } catch { return value; }
  const args = orchestrationContracts["agents.discover"].input.safeParse(input);
  const output = orchestrationContracts["agents.discover"].output.safeParse(value);
  if (!args.success || !output.success || !args.data.query?.trim() || output.data.specialists.length) return value;
  return {
    ...output.data,
    discoveryNotice: {
      code: "LITERAL_FILTER_NO_MATCH",
      message: "The query is a literal filter over the permitted roster's identifiers, names and descriptions. No matches does not mean no specialists are available. Call agents.discover with {} to list the permitted roster, then choose from the returned bindings.",
      retryInput: {},
    },
  };
}
