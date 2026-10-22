import type { PoolClient } from "pg";
import type { GithubRepositorySelection } from "./github";
import type { ResourceHandle } from "./resources";
export type ConnectionProfile="report-delivery-v1"|"github-public-read-v1"|"stash-read-v1"|"public-repository-read-v1"|"remote-mcp-v1"|"custom-api-v1"|"google-calendar-v1"|"microsoft-calendar-v1"|"hubspot-contacts-v1";
export interface ActionScope {accountId:string;organizationId:string}
export interface ConnectionDTO {id:string;name:string;targetId:string;targetLabel:string;resource:string;profileId:ConnectionProfile;authentication:"none"|"bearer";policyRevision:number;resources:ResourceHandle[];selections:GithubRepositorySelection[];stashItemIds:string[];revision:number;state:"active"|"revoked";createdAt:string;expiresAt:string}

export interface ConnectionCredentialPort {resolveCredential(db:PoolClient,scope:ActionScope,id:string,expectedPolicyRevision:number):Promise<{connection:ConnectionDTO;authorization:string}>}
