import assert from "node:assert/strict";
import { hasExecutionSequenceGap } from "./studio-execution-events";

// #28153 is a durable informational event which is intentionally absent from
// the visual trace. It must not be reported as a missing event.
assert.equal(hasExecutionSequenceGap([28152, 28153, 28154]), false);
assert.equal(hasExecutionSequenceGap([28152, 28154]), true);
assert.equal(hasExecutionSequenceGap(["28152", "28153", "28154", "28153"]), false);

console.log("studio execution event cursor: ok");
