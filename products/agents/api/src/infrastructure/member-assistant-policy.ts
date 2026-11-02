/** One rollout policy for member admission, task authority and outbound maintenance. */
export function memberAssistantPolicy(environment:NodeJS.ProcessEnv=process.env) {
  const organizationIds=(environment.AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS??'').split(',').map(value=>value.trim()).filter(Boolean);
  return {all:organizationIds.includes('*'),organizationIds};
}
export function memberAssistantEnabled(organizationId:string,environment:NodeJS.ProcessEnv=process.env):boolean {
  const policy=memberAssistantPolicy(environment);
  return policy.all||policy.organizationIds.includes(organizationId);
}
