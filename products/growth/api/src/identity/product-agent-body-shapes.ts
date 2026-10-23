// Source-owned shapes for duplicate-field rejection; semantic validation remains in the shared contract parsers.
const context = { type:'object', properties:{ kind:{},resourceId:{},range:{type:'object',properties:{from:{},to:{},timezone:{}}} } };
const draft = { type:'object',properties:{ title:{},content:{},channels:{type:'array',items:{}},channelSelections:{type:'object',additionalProperties:{}},variants:{type:'array',items:{type:'object',properties:{platform:{},content:{}}}} } };
const decision = { type:'object',properties:{requestId:{},payloadDigest:{},decision:{}} };
export const PRODUCT_AGENT_BODY_SHAPES:Record<string,unknown> = {
  'POST /api/agents/conversations':{type:'object',properties:{requestId:{},featureId:{},title:{},context}},
  'PATCH /api/agents/conversations/:conversationId/context':{type:'object',properties:{requestId:{},context}},
  'POST /api/agents/conversations/:conversationId/messages':{type:'object',properties:{requestId:{},text:{},context}},
  'POST /api/agents/tasks/:taskId/cancel':{type:'object',properties:{requestId:{}}},
  'PATCH /api/agents/tasks/:taskId/reviews/:reviewId':{type:'object',properties:{requestId:{},payloadDigest:{},draft}},
  'POST /api/agents/tasks/:taskId/reviews/:reviewId/decision':decision,
  'POST /api/agents/reviews/:reviewId/decision':decision,
  'POST /internal/agents/actions':{type:'object',properties:{version:{},requestId:{},tenantId:{},actor:{type:'object',properties:{issuer:{},subject:{}}},taskId:{},conversationId:{},featureId:{},operationId:{},context,contextRevision:{},operation:{},input:{type:'object',properties:{context,draft,reviewId:{},payloadDigest:{}}}}},
};
