import type { Pool } from "pg";
import { AdmissionStore } from "../../execution/admission/admission-store";
import { DeploymentStore } from "../deployments/deployment-store";
import { IdentityStore } from "../identity/identity-store";
import { AgentStore } from "./agent-store";

/** Product composition surface; execution consumers use AdmissionStore directly. */
export class PlatformStore {
  private readonly identityStore:IdentityStore;
  private readonly agentStore:AgentStore;
  private readonly deploymentStore:DeploymentStore;
  private readonly admissionStore:AdmissionStore;
  constructor(readonly pool:Pool) {
    this.identityStore=new IdentityStore(pool);
    this.agentStore=new AgentStore(pool);
    this.deploymentStore=new DeploymentStore(pool);
    this.admissionStore=new AdmissionStore(pool);
  }
  requireMembership=(...args:Parameters<IdentityStore["requireMembership"]>)=>this.identityStore.requireMembership(...args);
  ensureAccount=(...args:Parameters<IdentityStore["ensureAccount"]>)=>this.identityStore.ensureAccount(...args);
  createOrganization=(...args:Parameters<IdentityStore["createOrganization"]>)=>this.identityStore.createOrganization(...args);
  listOrganizations=(...args:Parameters<IdentityStore["listOrganizations"]>)=>this.identityStore.listOrganizations(...args);
  createSession=(...args:Parameters<IdentityStore["createSession"]>)=>this.identityStore.createSession(...args);
  getSession=(...args:Parameters<IdentityStore["getSession"]>)=>this.identityStore.getSession(...args);
  revokeSession=(...args:Parameters<IdentityStore["revokeSession"]>)=>this.identityStore.revokeSession(...args);
  revokeProviderSession=(...args:Parameters<IdentityStore["revokeProviderSession"]>)=>this.identityStore.revokeProviderSession(...args);
  listAgents=(...args:Parameters<AgentStore["listAgents"]>)=>this.agentStore.listAgents(...args);
  getAgent=(...args:Parameters<AgentStore["getAgent"]>)=>this.agentStore.getAgent(...args);
  createAgent=(...args:Parameters<AgentStore["createAgent"]>)=>this.agentStore.createAgent(...args);
  saveConfiguration=(...args:Parameters<AgentStore["saveConfiguration"]>)=>this.agentStore.saveConfiguration(...args);
  createConfiguredAgent=(...args:Parameters<AgentStore["createConfiguredAgent"]>)=>this.agentStore.createConfiguredAgent(...args);
  updateDraft=(...args:Parameters<AgentStore["updateDraft"]>)=>this.agentStore.updateDraft(...args);
  createVersion=(...args:Parameters<AgentStore["createVersion"]>)=>this.agentStore.createVersion(...args);
  listVersions=(...args:Parameters<AgentStore["listVersions"]>)=>this.agentStore.listVersions(...args);
  getVersion=(...args:Parameters<AgentStore["getVersion"]>)=>this.agentStore.getVersion(...args);
  createGrant=(...args:Parameters<AgentStore["createGrant"]>)=>this.agentStore.createGrant(...args);
  createGrantInTransaction=(...args:Parameters<AgentStore["createGrantInTransaction"]>)=>this.agentStore.createGrantInTransaction(...args);
  revokeGrant=(...args:Parameters<AgentStore["revokeGrant"]>)=>this.agentStore.revokeGrant(...args);
  listDeployments=(...args:Parameters<DeploymentStore["listDeployments"]>)=>this.deploymentStore.listDeployments(...args);
  publishWebsite=(...args:Parameters<DeploymentStore["publishWebsite"]>)=>this.deploymentStore.publishWebsite(...args);
  assertWebsiteConfigurationInTransaction=(...args:Parameters<DeploymentStore["assertWebsiteConfigurationInTransaction"]>)=>this.deploymentStore.assertWebsiteConfigurationInTransaction(...args);
  publishCurrentWebsite=(...args:Parameters<DeploymentStore["publishCurrentWebsite"]>)=>this.deploymentStore.publishCurrentWebsite(...args);
  getWebsiteDeployment=(...args:Parameters<DeploymentStore["getWebsiteDeployment"]>)=>this.deploymentStore.getWebsiteDeployment(...args);
  createWebsiteGrant=(...args:Parameters<DeploymentStore["createWebsiteGrant"]>)=>this.deploymentStore.createWebsiteGrant(...args);
  createWebsiteGrantInTransaction=(...args:Parameters<DeploymentStore["createWebsiteGrantInTransaction"]>)=>this.deploymentStore.createWebsiteGrantInTransaction(...args);
  admitTask=(...args:Parameters<AdmissionStore["admitTask"]>)=>this.admissionStore.admitTask(...args);
  admitTaskInTransaction=(...args:Parameters<AdmissionStore["admitTaskInTransaction"]>)=>this.admissionStore.admitTaskInTransaction(...args);
  getTask=(...args:Parameters<AdmissionStore["getTask"]>)=>this.admissionStore.getTask(...args);
  getConversation=(...args:Parameters<AdmissionStore["getConversation"]>)=>this.admissionStore.getConversation(...args);
  getConversationPage=(...args:Parameters<AdmissionStore["getConversationPage"]>)=>this.admissionStore.getConversationPage(...args);
  getEventPage=(...args:Parameters<AdmissionStore["getEventPage"]>)=>this.admissionStore.getEventPage(...args);
  listTaskEvents=(...args:Parameters<AdmissionStore["listTaskEvents"]>)=>this.admissionStore.listTaskEvents(...args);
}
