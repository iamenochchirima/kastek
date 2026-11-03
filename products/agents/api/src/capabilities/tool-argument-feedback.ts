import { builtinContract,capabilityContractMetadata } from "./tool-contracts";

export interface ToolArgumentIssue {
  path:(string|number)[]; code:string; message:string;
  type?:string; maximum?:number; minimum?:number;
}
type Schema=Record<string,unknown>;
function object(value:unknown):Schema|undefined{return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Schema:undefined;}
function safePath(path:readonly PropertyKey[],schema:unknown):(string|number)[]{
  const result:(string|number)[]=[];let node=object(schema);
  for(const segment of path.slice(0,8)){
    const properties=object(node?.properties);
    if(typeof segment==="string"&&properties&&Object.hasOwn(properties,segment)){
      result.push(segment);node=object(properties[segment]);
    }else if(typeof segment==="number"&&Number.isSafeInteger(segment)&&segment>=0&&segment<=1048576&&node?.type==="array"){
      result.push(segment);node=object(node.items);
    }else{result.push("(field)");break;}
  }
  return result;
}
const types=new Set(["array","string","number","int","object","boolean","null","undefined"]);
const bounded=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value)&&Math.abs(value)<=2147483647;

/** Error observations explain the fixed input contract without quoting submitted values or validator text. */
export function builtinArgumentFeedback(name:string,argumentsJson:string,errorCode:string,version?:string):{argumentIssues:ToolArgumentIssue[]}|undefined{
  if(errorCode!=="TOOL_ARGUMENTS_INVALID")return;
  const contract=builtinContract(name,version);if(!contract)return;
  let value:unknown;
  try{value=JSON.parse(argumentsJson);}catch{return{argumentIssues:[{path:[],code:"invalid_json",message:"Use valid JSON matching the tool schema."}]};}
  const parsed=contract.input.safeParse(value);if(parsed.success)return;
  const schema=capabilityContractMetadata(name,false,version).inputSchema;
  const issues:ToolArgumentIssue[]=parsed.error.issues.slice(0,6).map(issue=>{
    const result:ToolArgumentIssue={path:safePath(issue.path,schema),code:issue.code,message:"Check this field against the tool schema."};
    if(issue.code==="too_big"&&bounded(issue.maximum)){
      result.maximum=issue.maximum;
      result.message=`Use at most ${issue.maximum}${issue.origin==="array"?" items":issue.origin==="string"?" characters":""}.`;
      if(types.has(issue.origin))result.type=issue.origin;
    }else if(issue.code==="too_small"&&bounded(issue.minimum)){
      result.minimum=issue.minimum;
      result.message=`Use at least ${issue.minimum}${issue.origin==="array"?" items":issue.origin==="string"?" characters":""}.`;
      if(types.has(issue.origin))result.type=issue.origin;
    }else if(issue.code==="invalid_type"&&types.has(issue.expected)){
      result.type=issue.expected;result.message=`Expected ${issue.expected}.`;
    }else if(issue.code==="unrecognized_keys")result.message="Remove fields not listed in the tool schema.";
    else if(issue.code==="invalid_value")result.message="Choose a value listed in the tool schema.";
    else if(issue.code==="invalid_format")result.message="Use the required field format from the tool schema.";
    return result;
  });
  while(Buffer.byteLength(JSON.stringify(issues))>2048&&issues.length)issues.pop();
  return issues.length?{argumentIssues:issues}:undefined;
}
