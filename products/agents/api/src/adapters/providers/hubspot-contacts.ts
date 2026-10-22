import { z } from "zod";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { createBoundedFetch, type NetworkAttempt } from "../../infrastructure/connected-network";

export interface HubSpotContact { id:string; email:string; firstName?:string; lastName?:string }
export interface HubSpotContactIntent { organizationId:string; requestId:string; email:string; firstName?:string; lastName?:string; requestDigest:string }
export type HubSpotContactResult = {state:"confirmed";contactId:string;receiptDigest:string;created:boolean}
  | {state:"uncertain";reason:string;receiptDigest?:string};
export interface HubSpotContactsOptions {
  deadlineAt:number; signal?:AbortSignal; testBaseUrl?:string;
  beforeAttempt?(operation:"search"|"create"|"reconcile"):Promise<void>;
  onAttempt?(attempt:NetworkAttempt):Promise<void>;
}
const email=z.email().max(254).transform(value=>value.toLowerCase());
const name=z.string().trim().min(1).max(256).refine(value=>!/[\x00-\x1f\x7f]/.test(value));
const intentSchema=z.strictObject({organizationId:z.uuid(),requestId:z.uuid(),email,firstName:name.optional(),lastName:name.optional(),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)});
const contactSchema=z.object({id:z.string().regex(/^\d+$/).max(128),archived:z.boolean().optional(),properties:z.object({email,firstname:z.string().max(256).nullish(),lastname:z.string().max(256).nullish()})});
const contactsPath="/crm/objects/2026-09/contacts";
const failure=(code:string,message:string)=>new PlatformError(code,502,message);

/** Credentials, account authority and the durable single-send claim belong to the caller. */
export class HubSpotContactsClient {
  private readonly base:string;
  constructor(private readonly token:string,private readonly options:HubSpotContactsOptions) {
    if(!token||token.length>8192||/[\x00-\x20\x7f]/.test(token))throw failure("HUBSPOT_TOKEN_INVALID","HubSpot credentials are unavailable");
    this.base=options.testBaseUrl??"https://api.hubapi.com";
    if(options.testBaseUrl){const url=new URL(options.testBaseUrl);if(url.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw failure("HUBSPOT_ENDPOINT_INVALID","Invalid provider test endpoint");}
    this.base=this.base.replace(/\/$/,"");
  }
  private async request(operation:"search"|"create"|"reconcile",path:string,body:unknown,admitted?:()=>void):Promise<{status:number;data:unknown;digest:string}> {
    const url=`${this.base}${path}`;
    const fetcher=createBoundedFetch({authorizeUrl:value=>value.href===url,headers:{authorization:`Bearer ${this.token}`},maxRequestBytes:3000,maxResponseBytes:65536,
      deadlineAt:this.options.deadlineAt,maxAttempts:1,maxRequests:1,signal:this.options.signal,testLoopback:!!this.options.testBaseUrl,returnProviderErrorResponses:true,
      beforeAttempt:async()=>{await this.options.beforeAttempt?.(operation);admitted?.();},onAttempt:this.options.onAttempt});
    const response=await fetcher(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),redirect:"error"});
    const text=await response.text();
    if(text.includes(this.token))throw failure("HUBSPOT_CREDENTIAL_REFLECTION","Provider reflected private credentials");
    let data:unknown;
    try{data=text?JSON.parse(text):{};}catch{throw failure("HUBSPOT_RESPONSE_INVALID","HubSpot returned an invalid response");}
    if(!data||typeof data!=="object"||Array.isArray(data))throw failure("HUBSPOT_RESPONSE_INVALID","HubSpot returned an invalid response");
    return {status:response.status,data,digest:requestDigest({status:response.status,data})};
  }
  private project(raw:unknown):HubSpotContact {
    const contact=contactSchema.parse(raw);
    if(contact.archived)throw failure("HUBSPOT_RESPONSE_INVALID","HubSpot returned an archived contact");
    return {id:contact.id,email:contact.properties.email,...(contact.properties.firstname?{firstName:contact.properties.firstname}:{}),...(contact.properties.lastname?{lastName:contact.properties.lastname}:{})};
  }
  private async lookup(value:string,operation:"search"|"reconcile"):Promise<{contacts:HubSpotContact[];digest:string}> {
    const exactEmail=email.parse(value);
    const response=await this.request(operation,`${contactsPath}/search`,{filterGroups:[{filters:[{propertyName:"email",operator:"EQ",value:exactEmail}]}],properties:["email","firstname","lastname"],limit:2});
    if(response.status!==200)throw failure("HUBSPOT_CONTACT_SEARCH_FAILED","HubSpot contacts could not be searched");
    const parsed=z.object({total:z.number().int().nonnegative(),results:z.array(contactSchema).max(2),paging:z.object({next:z.unknown().optional()}).optional()}).parse(response.data);
    if(parsed.total!==parsed.results.length||parsed.total>1||parsed.paging?.next)throw failure("HUBSPOT_CONTACT_AMBIGUOUS","Contact lookup did not identify one exact record");
    const contacts=parsed.results.map(value=>this.project(value));
    if(contacts.some(contact=>contact.email!==exactEmail))throw failure("HUBSPOT_CONTACT_EMAIL_MISMATCH","Contact lookup returned a different email");
    return {contacts,digest:response.digest};
  }
  async searchContacts(input:{email:string}):Promise<HubSpotContact[]> {
    return (await this.lookup(z.strictObject({email}).parse(input).email,"search")).contacts;
  }
  private result(intent:HubSpotContactIntent,contact:HubSpotContact,digest:string,created:boolean):HubSpotContactResult {
    if(contact.email!==intent.email||intent.firstName!==undefined&&contact.firstName!==intent.firstName||intent.lastName!==undefined&&contact.lastName!==intent.lastName)return {state:"uncertain",reason:"CONTACT_INTENT_MISMATCH",receiptDigest:digest};
    return {state:"confirmed",contactId:contact.id,receiptDigest:digest,created};
  }
  async reconcileContact(raw:HubSpotContactIntent):Promise<HubSpotContactResult> {
    const intent=intentSchema.parse(raw);
    try{
      const found=await this.lookup(intent.email,"reconcile");
      // Search is eventually consistent. A matching record proves the desired state, not who created it.
      return found.contacts[0]?this.result(intent,found.contacts[0],found.digest,false):{state:"uncertain",reason:"CONTACT_NOT_OBSERVED",receiptDigest:found.digest};
    }catch{return {state:"uncertain",reason:"RECONCILIATION_UNAVAILABLE"};}
  }
  async createContact(raw:HubSpotContactIntent):Promise<HubSpotContactResult> {
    const intent=intentSchema.parse(raw),found=await this.lookup(intent.email,"search");
    if(found.contacts[0])return this.result(intent,found.contacts[0],found.digest,false);
    const properties={email:intent.email,...(intent.firstName!==undefined?{firstname:intent.firstName}:{}),...(intent.lastName!==undefined?{lastname:intent.lastName}:{})};
    let admitted=false;
    try{
      const response=await this.request("create",contactsPath,{properties},()=>{admitted=true;});
      if(response.status===201)return this.result(intent,this.project(response.data),response.digest,true);
      if(response.status!==409&&response.status<500)return {state:"uncertain",reason:`CREATE_HTTP_${response.status}`,receiptDigest:response.digest};
    }catch(error){if(!admitted)throw error;}
    return this.reconcileContact(intent);
  }
}
