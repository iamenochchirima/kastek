import test from "node:test";
import assert from "node:assert/strict";
import { parseGrowthAgentAction } from "../dist/index.js";

test("Operation review reads retain exact task/actor scope and accept no hidden mutation fields", () => {
  const action={version:"1",requestId:"request",tenantId:"business",actor:{issuer:"https://growth.test/identity",subject:"user"},taskId:"task",conversationId:"conversation",featureId:"content",operationId:"operation",context:null,operation:"operation.review.read",input:{reviewId:"review"}};
  assert.deepEqual(parseGrowthAgentAction(action),action);
  assert.throws(()=>parseGrowthAgentAction({...action,input:{}}));
  assert.throws(()=>parseGrowthAgentAction({...action,input:{reviewId:"review",decision:"approve"}}));
  assert.throws(()=>parseGrowthAgentAction({...action,input:{reviewId:"review",tenantId:"other"}}));
  assert.throws(()=>parseGrowthAgentAction({...action,actor:{issuer:"https://growth.test/identity"}}));
});
