/** Read only typed connection/account ID string tokens from the start of a legacy JSON result.
 * The transport may cut the document at any character, including inside a JSON escape.
 */
export function legacyControlPrefix(chunk:string,operation:string):string[] {
  const collection=operation==="connections.list"?"connections":operation==="content.accounts.list"?"accounts":null;
  if(!collection||Buffer.byteLength(chunk)>8192)return [];
  type Frame={kind:"object"|"array";path:string[];state:"key"|"colon"|"value"|"comma";key?:string};
  const stack:Frame[]=[],found:string[]=[];let index=0,root=false;
  const whitespace=()=>{while(index<chunk.length&&" \n\r\t".includes(chunk[index]!))index++;};
  const string=():string|undefined=>{
    if(chunk[index]!=="\"")return undefined;
    const start=index++;let escaped=false;
    while(index<chunk.length){const ch=chunk[index++]!;if(escaped){escaped=false;continue;}if(ch==="\\"){escaped=true;continue;}
      if(ch==='"'){try{return JSON.parse(chunk.slice(start,index)) as string;}catch{return undefined;}}}
    return undefined;
  };
  const pathFor=(frame:Frame)=>frame.kind==="array"?[...frame.path,"*"]:[...frame.path,frame.key!];
  const complete=(frame:Frame)=>{frame.state="comma";};
  while(index<chunk.length){
    whitespace();if(index>=chunk.length)break;
    const frame=stack.at(-1),ch=chunk[index]!;
    if(!frame){if(root||ch!=="{")break;root=true;index++;stack.push({kind:"object",path:[],state:"key"});continue;}
    if(frame.kind==="object"&&frame.state==="key"){
      if(ch==='}'){index++;stack.pop();continue;}
      const key=string();if(key===undefined)break;frame.key=key;frame.state="colon";continue;
    }
    if(frame.state==="colon"){if(ch!==":")break;index++;frame.state="value";continue;}
    if(frame.state==="comma"){
      if(ch===(frame.kind==="object"?"}":"]")){index++;stack.pop();continue;}
      if(ch!==",")break;index++;frame.state=frame.kind==="object"?"key":"value";continue;
    }
    if(frame.kind==="array"&&ch==="]"){index++;stack.pop();continue;}
    const path=pathFor(frame);
    if(ch==="{"||ch==="["){complete(frame);index++;stack.push({kind:ch==="{"?"object":"array",path,state:ch==="{"?"key":"value"});continue;}
    if(ch==='"'){
      const value=string();if(value===undefined)break;
      if(path.length===4&&path[0]==="result"&&path[1]===collection&&path[2]==="*"&&["id","externalAccountId",...(collection==="accounts"?["external_account_id"]:[])].includes(path[3]!))found.push(value);
      complete(frame);continue;
    }
    const start=index;while(index<chunk.length&&!",]} \n\r\t".includes(chunk[index]!))index++;
    if(index===chunk.length)break;
    try{const value=JSON.parse(chunk.slice(start,index));if(value!==null&&typeof value==="object")break;}catch{break;}
    complete(frame);
  }
  return found;
}
