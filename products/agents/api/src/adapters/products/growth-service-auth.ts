import {createPublicKey} from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import type { GrowthAgentCommand } from "@kasitek-labs/contracts";
import { PlatformError, requestDigest } from "../../contracts/contracts";
export interface GrowthServiceTrust {issuer:string;actorIssuer:string;keys:Record<string,string>;controlKeys?:Record<string,string>;controlClientId?:string}
export class GrowthServiceAuth {
  private readonly keys:Map<string,ReturnType<typeof importSPKI>>;
  private readonly controlKeys:Map<string,ReturnType<typeof importSPKI>>;
  constructor(readonly trust:GrowthServiceTrust) {
    const readKeys=(values:Record<string,string>,required:boolean)=>{
      if(!values||typeof values!=="object"||Array.isArray(values)||Object.keys(values).length>8||required&&!Object.keys(values).length)throw Error("Invalid Growth service key set");
      return new Map(Object.entries(values).map(([id,pem])=>{
        if(!id||id.length>128||typeof pem!=="string")throw Error("Invalid Growth service key");
        const key=createPublicKey(pem.replace(/\\n/g,"\n"));
        if(key.asymmetricKeyType!=="rsa"||(key.asymmetricKeyDetails?.modulusLength??0)<2048)throw Error("Growth service keys require RSA 2048 or stronger");
        return [id,importSPKI(String(key.export({type:"spki",format:"pem"})),"RS256")];
      }));
    };
    this.keys=readKeys(trust.keys,true);
    this.controlKeys=readKeys(trust.controlKeys??{},false);
  }
  async verify(token:string,command:GrowthAgentCommand):Promise<{clientId:string;jti:string;expiresAt:Date}> {
    try {
      const result=await jwtVerify(token,async header=>{
        const keys=command.operation==="features.configure"?this.controlKeys:this.keys;
        const key=header.kid?keys.get(header.kid):keys.size===1?[...keys.values()][0]:undefined;
        if(!key)throw Error("Unknown service key");return await key;
      },{issuer:this.trust.issuer,audience:"agents-product-api",algorithms:["RS256"],clockTolerance:5,
        requiredClaims:["sub","iat","exp","jti"]});
      const p=result.payload,now=Math.floor(Date.now()/1000);
      if(p.product!=="growth"||p.requestDigest!==requestDigest(command)||typeof p.iat!=="number"||typeof p.exp!=="number"||
        p.exp-p.iat>120||p.exp<=p.iat||p.iat>now+5||typeof p.jti!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.jti)||
        !["growth-api",this.trust.controlClientId??"growth-control"].includes(p.sub!)||
        command.actor.issuer!==this.trust.actorIssuer)throw Error("Service scope mismatch");
      if(command.operation==="features.configure"&&p.sub!==(this.trust.controlClientId??"growth-control"))throw Error("Control plane denied");
      return {clientId:p.sub!,jti:p.jti,expiresAt:new Date(p.exp*1000)};
    } catch {throw new PlatformError("PRODUCT_SERVICE_DENIED",401,"The product service request is invalid");}
  }
}
export function growthServiceTrustFromEnvironment(env:NodeJS.ProcessEnv=process.env):GrowthServiceTrust|undefined {
  let keys:Record<string,string>;
  if(env.GROWTH_AGENTS_PUBLIC_KEYS_JSON)keys=JSON.parse(env.GROWTH_AGENTS_PUBLIC_KEYS_JSON);
  else if(env.GROWTH_AGENTS_PUBLIC_KEY)keys={[env.GROWTH_AGENTS_KEY_ID??"growth-v1"]:env.GROWTH_AGENTS_PUBLIC_KEY};
  else return;
  const issuer=env.GROWTH_AGENTS_ISSUER??"https://growth.kasitek.co.za";
  return {issuer,actorIssuer:env.GROWTH_IDENTITY_ISSUER??issuer+"/identity",keys,controlKeys:env.GROWTH_AGENTS_CONTROL_PUBLIC_KEYS_JSON?JSON.parse(env.GROWTH_AGENTS_CONTROL_PUBLIC_KEYS_JSON):undefined,controlClientId:env.GROWTH_AGENTS_CONTROL_CLIENT_ID??"growth-control"};
}
