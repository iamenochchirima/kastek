import { useEffect, useRef, useState, type FormEvent } from "react";
import { Globe, MessageCircle, Send, Instagram, MessagesSquare } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, ApiError, organizationPath } from "./api";
import { WebsiteChannelSettings } from "./website-channel-settings";
import { channelApi, channelError, channelNames, type CustomerChannel, type ChannelConnection, type ChannelList, type ChannelAsset, type MetaBegin, type TelegramSetup, type ChannelKind } from "./channel-api";

type Facebook = { init(options:Record<string,unknown>):void; login(callback:(response:{authResponse?:{code?:string}})=>void,options:Record<string,unknown>):void };
declare global { interface Window { FB?:Facebook } }
async function facebookSdk(appId:string,version:string):Promise<Facebook> {
  if(!window.FB) await new Promise<void>((resolve,reject)=>{
    const existing=document.getElementById("agents-facebook-sdk");
    const script=(existing as HTMLScriptElement|null) ?? document.createElement("script");
    const timeout=setTimeout(()=>{script.remove();reject(new Error("Facebook signup could not load. Try again."));},15000);
    script.addEventListener("load",()=>{clearTimeout(timeout);resolve();},{once:true});
    script.addEventListener("error",()=>{clearTimeout(timeout);script.remove();reject(new Error("Facebook signup could not load. Try again."));},{once:true});
    if(!existing){script.id="agents-facebook-sdk";script.async=true;script.src="https://connect.facebook.net/en_US/sdk.js";document.head.append(script);}
  });
  if(!window.FB)throw new Error("Facebook signup is unavailable.");window.FB.init({appId,version,xfbml:false});return window.FB;
}
const stateNames:Record<ChannelConnection["state"],string>={pending:"Setup incomplete",active:"Connected",needs_attention:"Needs attention",disconnected:"Disconnected",removed:"Removed"};
const modeNames:Record<string,string>={meta:"Facebook login",instagram_login:"Instagram login",cloud_api:"WhatsApp Business",bot:"Telegram bot",website:"Website"};
type Setup={kind:ChannelKind;connection?:ChannelConnection};
const resumeKey = (organizationId: string) => `agents.channel-setup.${organizationId}`;
export function channelSetupContext(organizationId: string, params: URLSearchParams): URLSearchParams {
  const restored = new URLSearchParams(params);
  if (!params.get("state")) return restored;
  try {
    const pending = JSON.parse(sessionStorage.getItem(resumeKey(organizationId)) ?? "null");
    if (!pending || pending.state !== params.get("state") || typeof pending.expiresAt !== "number" || pending.expiresAt < Date.now()) return restored;
    for (const key of ["agentId", "returnTo", "channel"] as const) {
      if (!restored.has(key) && typeof pending[key] === "string") restored.set(key, pending[key]);
    }
  } catch { /* A blocked or cleared browser store does not prevent authorization. */ }
  return restored;
}

export function CustomerChannels({organizationId,owner,defaultAgentId,query = ""}:{organizationId:string;owner:boolean;defaultAgentId?:string;query?:string}) {
  const [params,setParams]=useSearchParams(),{confirm}=useConfirmationDialog();
  const [catalogue,setCatalogue]=useState<CustomerChannel[]>([]),[data,setData]=useState<ChannelList|null>(null),[error,setError]=useState("");
  const [setup,setSetup]=useState<Setup|null>(null),[busy,setBusy]=useState(false),[name,setName]=useState(""),[secret,setSecret]=useState(""),[mode,setMode]=useState("");
  const [agents,setAgents]=useState<{id:string;name:string}[]>([]),[agentCursor,setAgentCursor]=useState<string|null>(null),[agentId,setAgentId]=useState("");
  const [ticket,setTicket]=useState(""),[assets,setAssets]=useState<ChannelAsset[]>([]),[assetCursor,setAssetCursor]=useState<string|null>(null),[assetId,setAssetId]=useState(""),[pin,setPin]=useState("");
  const [replacement,setReplacement]=useState(""),[signup,setSignup]=useState<Extract<MetaBegin,{flow:"embedded_signup"}>|null>(null),[sdk,setSdk]=useState<Facebook|null>(null);
  const [signupCode,setSignupCode]=useState(""),[wabaId,setWabaId]=useState(""),[manual,setManual]=useState(false);
  const callback=useRef<{state:string;promise:Promise<{ticket:string;connectionId:string}>}|null>(null),signupCompleted=useRef("");
  const openedIntent = useRef("");
  const definition=catalogue.find(item=>item.kind===setup?.kind);
  const activeBinding=data?.deployments.find(item=>item.connectionId===setup?.connection?.id&&item.state==="active");
  const ingressFailure=data?.ingressFailures?.find(item=>item.connectionId===setup?.connection?.id);
  const uncertainSetup=data?.setupClaims?.find(item=>item.connectionId===setup?.connection?.id&&item.state!=="complete");
  async function refresh() {const result=await channelApi<ChannelList>(organizationId);setData(result);return result;}
  useEffect(()=>{let active=true;Promise.all([channelApi<{channels:CustomerChannel[]}>(organizationId,"/catalogue"),channelApi<ChannelList>(organizationId),api<{agents:{id:string;name:string}[];nextCursor:string|null}>(`${organizationPath(organizationId)}/agents/summaries?limit=100`)])
    .then(async ([catalogue,list,options])=>{
      if(defaultAgentId && !options.agents.some(agent=>agent.id===defaultAgentId)) {
        try { const result=await api<{agent:{id:string;name:string}}>(`${organizationPath(organizationId)}/agents/${encodeURIComponent(defaultAgentId)}`); options.agents.push({id:result.agent.id,name:result.agent.name}); }
        catch(cause) { if(active)setError(channelError(cause)); }
      }
      if(active){setCatalogue(catalogue.channels);setData(list);setAgents(options.agents);setAgentCursor(options.nextCursor);}
    }).catch(cause=>{if(active)setError(channelError(cause));});return()=>{active=false;};},[organizationId,defaultAgentId]);
  async function ensureAgentOption(id: string) {
    if(!id || agents.some(agent=>agent.id===id))return;
    try { const {agent}=await api<{agent:{id:string;name:string}}>(`${organizationPath(organizationId)}/agents/${encodeURIComponent(id)}`);setAgents(current=>current.some(item=>item.id===agent.id)?current:[...current,{id:agent.id,name:agent.name}]); }
    catch(cause) { setError(channelError(cause)); }
  }
  function open(kind:ChannelKind,connection?:ChannelConnection) {
    const current=catalogue.find(item=>item.kind===kind);setSetup({kind,connection});setName(connection?.name??current?.name??channelNames[kind]);setMode(connection?.mode??current?.modes.find(item=>item.available)?.id??current?.modes[0]?.id??"");
    setSecret("");setError("");setTicket("");setAssets([]);setAssetId("");setPin("");setReplacement("");setSignup(null);setSdk(null);setSignupCode("");setWabaId("");setManual(false);
    const serving=data?.deployments.find(item=>item.connectionId===connection?.id&&item.state==="active")?.agentId??(agents.some(agent=>agent.id===defaultAgentId)?defaultAgentId!:"");
    setAgentId(serving);void ensureAgentOption(serving);
  }
  const requestedChannel = params.get("channel");
  useEffect(()=>{
    if(!owner || !data || !catalogue.length || params.has("code") || params.has("state") || params.has("error"))return;
    const intent=`${organizationId}:${requestedChannel}:${defaultAgentId??""}`;
    if(!requestedChannel || openedIntent.current===intent)return;
    const channel=catalogue.find(item=>item.kind===requestedChannel);
    if(!channel)return;
    openedIntent.current=intent;
    if(channel.modes.some(item=>item.available)) {
      const existing=defaultAgentId?data.connections.find(connection=>connection.kind===channel.kind&&data.deployments.some(binding=>binding.connectionId===connection.id&&binding.agentId===defaultAgentId&&binding.state==="active")):undefined;
      open(channel.kind,existing);
    }
    // The intent opens once after the scoped catalogue and agent options load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[owner,data,catalogue,requestedChannel,defaultAgentId,organizationId,params]);
  function close() {if(!busy){setSetup(null);setSecret("");setSignup(null);setSignupCode("");setWabaId("");setTicket("");setError("");}}
  async function discover(value:string,cursor?:string) {const page=await channelApi<{assets:ChannelAsset[];nextCursor:string|null}>(organizationId,"/meta/assets",{ticket:value,...(cursor?{cursor}:{})});setAssets(previous=>cursor?[...new Map([...previous,...page.assets].map(item=>[item.id,item])).values()]:page.assets);setAssetCursor(page.nextCursor);}
  async function authorized(result:{ticket:string;connectionId:string}) {
    const {connection}=await channelApi<{connection:ChannelConnection}>(organizationId,`/${result.connectionId}`);
    const current=await refresh();setSetup({kind:connection.kind,connection});const serving=current.deployments.find(item=>item.connectionId===connection.id&&item.state==="active")?.agentId??defaultAgentId??"";setAgentId(serving);await ensureAgentOption(serving);setName(connection.name);setMode(connection.mode);setTicket(result.ticket);setAssetId("");setSecret("");setSignup(null);await discover(result.ticket);await refresh();
  }
  const code=params.get("code"),oauthState=params.get("state"),authorizationError=params.get("error");
  useEffect(()=>{
    if(!owner||(!authorizationError&&(!code||!oauthState)))return;
    if(authorizationError){setError("Authorization cancelled. Connect the account again.");const next=channelSetupContext(organizationId,params);openedIntent.current=`${organizationId}:${next.get("channel")}:${next.get("agentId")??""}`;for(const key of ["code","state","error","error_description","error_reason"])next.delete(key);setParams(next,{replace:true});return;}
    let active=true;setBusy(true);
    if(!callback.current||callback.current.state!==oauthState)callback.current={state:oauthState!,promise:channelApi<{ticket:string;connectionId:string}>(organizationId,"/meta/complete",{state:oauthState,code})};
    void callback.current.promise.then(result=>{if(active)return authorized(result);}).catch(cause=>{if(active)setError(channelError(cause));}).finally(()=>{if(active){setBusy(false);const next=channelSetupContext(organizationId,params);openedIntent.current=`${organizationId}:${next.get("channel")}:${next.get("agentId")??""}`;next.delete("code");next.delete("state");setParams(next,{replace:true});try { sessionStorage.removeItem(resumeKey(organizationId)); } catch { /* Authorization is already complete. */ }}});
    return()=>{active=false;};
    // The callback handle owns a single session-bound exchange, even if the component remount effect is replayed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[organizationId,owner,code,oauthState,authorizationError]);
  useEffect(()=>{
    if(!signup)return;
    const allowed=new Set(signup.messageOrigins.filter(origin=>["https://www.facebook.com","https://web.facebook.com"].includes(origin)));
    const message=(event:MessageEvent)=>{
      if(!allowed.has(event.origin)||!event.source||event.source===window)return;
      let payload:unknown=event.data;try{if(typeof payload==="string")payload=JSON.parse(payload);}catch{return;}
      if(!payload||typeof payload!=="object")return;const result=payload as {type?:string;event?:string;data?:{waba_id?:unknown}};
      if(result.type!=="WA_EMBEDDED_SIGNUP")return;
      if(result.event==="FINISH"&&typeof result.data?.waba_id==="string")setWabaId(result.data.waba_id);
      else if(result.event==="CANCEL"||result.event==="ERROR"){setError("WhatsApp signup was not completed. Try again.");setSignupCode("");setWabaId("");}
    };window.addEventListener("message",message);return()=>window.removeEventListener("message",message);
  },[signup]);
  useEffect(()=>{
    if(!signup||!signupCode||!wabaId||signupCompleted.current===signup.state)return;
    signupCompleted.current=signup.state;setBusy(true);
    void channelApi<{ticket:string;connectionId:string}>(organizationId,"/meta/complete",{state:signup.state,code:signupCode,wabaId}).then(authorized).catch(cause=>setError(channelError(cause))).finally(()=>setBusy(false));
    // Complete only the currently initiated signup after both SDK code and exact-origin asset event arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[organizationId,signup,signupCode,wabaId]);
  async function connect(event:FormEvent) {
    event.preventDefault();if(!setup)return;setBusy(true);setError("");
    try{
      if(setup.kind==="telegram"){
        const result=setup.connection?await channelApi<TelegramSetup>(organizationId,`/${setup.connection.id}/telegram/rotate`,{expectedRevision:setup.connection.revision,botToken:secret}):await channelApi<TelegramSetup>(organizationId,"/telegram/connect",{name,botToken:secret});
        setSetup({kind:"telegram",connection:result.connection});setReplacement(result.replacementConfirmation??"");setSecret("");await refresh();return;
      }
      const connection=setup.connection??(await channelApi<{connection:ChannelConnection}>(organizationId,"",{kind:setup.kind,name,mode})).connection;
      setSetup({...setup,connection});
      if(manual&&setup.kind==="whatsapp"){await authorized(await channelApi<{ticket:string;connectionId:string}>(organizationId,"/meta/manual",{connectionId:connection.id,expectedRevision:connection.revision,accessToken:secret,wabaId}));return;}
      const result=await channelApi<MetaBegin>(organizationId,"/meta/begin",{connectionId:connection.id,expectedRevision:connection.revision});
      if(result.flow==="oauth"){
        try { sessionStorage.setItem(resumeKey(organizationId),JSON.stringify({state:result.state,expiresAt:Date.now()+15*60_000,agentId,channel:setup.kind,returnTo:params.get("returnTo")??""})); }
        catch { /* Browser storage may be unavailable; authorization can still proceed. */ }
        window.location.assign(result.authorizationUrl);return;
      }
      setSignup(result);setSignupCode("");setWabaId("");setSdk(await facebookSdk(result.appId,result.apiVersion));
    }catch(cause){setError(channelError(cause));}finally{setBusy(false);}
  }
  async function selectAsset() {
    setBusy(true);setError("");try{const result=await channelApi<{connection:ChannelConnection}>(organizationId,"/meta/select",{ticket,assetId,...(pin?{registrationPin:pin}:{})});setSetup(current=>current?{...current,connection:result.connection}:null);setTicket("");await refresh();}catch(cause){setError(channelError(cause));}finally{setBusy(false);}
  }
  async function reconcileSetup(){
    setBusy(true);setError("");try{
      const result=await channelApi<{connection:ChannelConnection;status:string}>(organizationId,"/meta/reconcile",{ticket,assetId,intent:"connect"});
      setSetup(current=>current?{...current,connection:result.connection}:null);setTicket("");await refresh();
      if(result.status!=="active")setError("The previous subscription was not confirmed. Authorize again to finish connecting.");
    }catch(cause){setTicket("");setError(channelError(cause));}finally{setBusy(false);}
  }
  async function bind(reassign=false) {
    const connection=setup?.connection;if(!connection)return;setBusy(true);setError("");
    try{await channelApi(organizationId,`/${connection.id}/bind`,{expectedRevision:connection.revision,agentId,...(reassign?{confirmReassignment:true}:{})});await refresh();toast.success("Agent connected");setSetup(null);}
    catch(cause){if(cause instanceof ApiError&&cause.code==="CHANNEL_REASSIGNMENT_REQUIRED"){if(await confirm({title:"Change serving agent?",description:"New conversations will use the selected agent. Existing history remains available.",confirmLabel:"Change agent"})){setBusy(false);await bind(true);}}else setError(channelError(cause));}finally{setBusy(false);}
  }
  async function disconnect(connection:ChannelConnection) {
    if(!await confirm({title:"Disconnect channel?",description:"Future sends stop. Provider requests already accepted or uncertain may still complete.",confirmLabel:"Disconnect",variant:"destructive"}))return;
    setBusy(true);setError("");try{const result=await channelApi<{connection:ChannelConnection;unsubscribe?:string}>(organizationId,`/${connection.id}/disconnect`,{expectedRevision:connection.revision});setSetup({kind:connection.kind,connection:result.connection});await refresh();if(result.unsubscribe==="unconfirmed")setError("Disconnected locally. Provider subscription cleanup is unconfirmed.");else toast.success("Channel disconnected");}catch(cause){setError(channelError(cause));}finally{setBusy(false);}
  }
  async function remove(connection:ChannelConnection) {
    if(!await confirm({title:"Remove connection?",description:"Conversation history remains available.",confirmLabel:"Remove",variant:"destructive"}))return;
    setBusy(true);setError("");try{await channelApi(organizationId,`/${connection.id}`,{expectedRevision:connection.revision},"DELETE");await refresh();setSetup(null);toast.success("Connection removed");}catch(cause){setError(channelError(cause));}finally{setBusy(false);}
  }
  async function telegramSetup(confirmReplacement?:string){const connection=setup?.connection;if(!connection)return;setBusy(true);setError("");try{const result=await channelApi<TelegramSetup>(organizationId,`/${connection.id}/telegram/setup`,{expectedRevision:connection.revision,...(confirmReplacement?{confirmReplacement}:{})});setSetup({kind:"telegram",connection:result.connection});setReplacement(result.replacementConfirmation??"");await refresh();}catch(cause){setError(channelError(cause));}finally{setBusy(false);}}
  async function health(){const connection=setup?.connection;if(!connection)return;setBusy(true);setError("");try{const result=await channelApi<TelegramSetup>(organizationId,`/${connection.id}/health`,{expectedRevision:connection.revision});setSetup({kind:connection.kind,connection:result.connection});await refresh();toast.success(["active","healthy"].includes(result.status)?"Connection healthy":"Connection needs attention");}catch(cause){setError(channelError(cause));}finally{setBusy(false);}}
  async function moreAgents(){if(!agentCursor)return;setBusy(true);try{const page=await api<{agents:{id:string;name:string}[];nextCursor:string|null}>(`${organizationPath(organizationId)}/agents/summaries?limit=100&cursor=${encodeURIComponent(agentCursor)}`);setAgents(previous=>[...new Map([...previous,...page.agents].map(item=>[item.id,item])).values()]);setAgentCursor(page.nextCursor);}catch(cause){setError(channelError(cause));}finally{setBusy(false);}}
  const agentPicker=<label className="block space-y-2 text-sm">Agent<select aria-label="Serving agent" className="min-h-10 w-full rounded-md border bg-background px-3" value={agentId} disabled={busy} onChange={event=>setAgentId(event.target.value)}><option value="">Select an agent</option>{agents.map(agent=><option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>{agentCursor?<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={()=>void moreAgents()}>Load more agents</Button>:null}</label>;
  return <section className="mb-8 space-y-4" aria-label="Customer channels"><h2 className="connection-section-title">Customer channels</h2>{!setup&&error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}
    {data?.connections.length?<ul className="divide-y rounded-md border">{data.connections.filter(connection => `${connection.name} ${channelNames[connection.kind]}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(connection=>{const binding=data.deployments.find(item=>item.connectionId===connection.id&&item.state==="active");return <li key={connection.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-4"><div className="min-w-0"><p className="break-words text-sm font-medium">{connection.name}</p><p className="mt-1 break-words text-xs text-muted-foreground">{channelNames[connection.kind]} · {stateNames[connection.state]}{binding?` · ${agents.find(agent=>agent.id===binding.agentId)?.name??"Agent assigned"}`:" · No agent assigned"}</p></div>{owner?<Button size="sm" variant="outline" onClick={()=>open(connection.kind,connection)}>Manage</Button>:null}</li>;})}</ul>:null}
    {data?.websites.length?<ul className="divide-y rounded-md border">{data.websites.filter(item => `${item.agentName} ${item.allowedOrigins.join(" ")} website`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(item=><li key={item.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-4"><div className="min-w-0"><p className="text-sm font-medium">{item.agentName}</p><p className="mt-1 break-all text-xs text-muted-foreground">Website · {item.allowedOrigins.join(", ")}</p></div><Link className="text-sm underline underline-offset-4" to={`/app/agents/${item.agentId}?section=publish`}>Manage website</Link></li>)}</ul>:null}
    <ul className="connection-grid">{catalogue.filter(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(item=>{const available=item.modes.some(mode=>mode.available);const Icon=item.kind==="website"?Globe:item.kind==="instagram"?Instagram:item.kind==="telegram"?Send:item.kind==="whatsapp"?MessageCircle:MessagesSquare;return <li key={item.kind} className="connection-entry"><span className="connection-entry-icon"><Icon size={19} strokeWidth={1.7} aria-hidden="true" /></span><div className="connection-entry-body"><h3>{item.name}</h3><p>{available ? "Available to connect" : "Setup unavailable"}</p></div>{owner?<Button className="connection-entry-actions" size="sm" variant="outline" disabled={!available||busy} onClick={()=>open(item.kind)}>Connect</Button>:null}</li>;})}</ul>
    <Dialog open={Boolean(setup)} onOpenChange={value=>{if(!value)close();}}><DialogContent showCloseButton={!busy} className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{setup?.connection?"Manage":"Connect"} {setup?channelNames[setup.kind]:"channel"}</DialogTitle><DialogDescription>{setup?.connection?stateNames[setup.connection.state]:definition?.assetLabel??"Choose an account and agent."}</DialogDescription></DialogHeader>
      {error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}
      {setup?.kind==="website"?<div className="space-y-4">{agentPicker}{agentId?<WebsiteChannelSettings organizationId={organizationId} agentId={agentId} owner={owner}/>:null}</div>:null}
      {setup&&setup.kind!=="website"&&setup.connection?.state==="active"&&!ticket?<><div className="text-sm"><p className="break-words">{setup.connection.assetId}</p><p className="mt-1 text-xs text-muted-foreground">{activeBinding?`Serving ${agents.find(agent=>agent.id===activeBinding.agentId)?.name??"assigned agent"}`:"Choose an agent to start serving customers."}</p></div>{agentPicker}<Button disabled={!agentId||busy||activeBinding?.agentId===agentId} onClick={()=>void bind()}>{busy?"Saving…":"Connect agent"}</Button></>:null}
      {ticket?<><label className="block space-y-2 text-sm">{definition?.assetLabel??"Account"}<select aria-label="Channel asset" className="min-h-10 w-full rounded-md border bg-background px-3" value={assetId} disabled={busy} onChange={event=>setAssetId(event.target.value)}><option value="">Select an asset</option>{assets.map(asset=><option key={asset.id} value={asset.id} disabled={!asset.eligible}>{asset.name}{!asset.eligible?` · ${asset.reasonCode??"Unavailable"}`:""}</option>)}</select></label>{!assets.length?<p className="text-sm text-muted-foreground">No eligible assets returned</p>:null}{assetCursor?<Button variant="outline" size="sm" disabled={busy} onClick={()=>{setBusy(true);void discover(ticket,assetCursor).catch(cause=>setError(channelError(cause))).finally(()=>setBusy(false));}}>Load more assets</Button>:null}{assets.find(asset=>asset.id===assetId)?.metadata.registrationRequired===true?<label className="block space-y-2 text-sm">Registration PIN<Input aria-label="Registration PIN" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={pin} onChange={event=>setPin(event.target.value)}/></label>:null}<Button disabled={!assetId||busy||!!uncertainSetup} onClick={()=>void selectAsset()}>{busy?"Connecting…":"Use selected asset"}</Button>{uncertainSetup?<div className="space-y-2"><p className="text-sm text-muted-foreground">Check the previous setup before making another subscription.</p><Button variant="outline" disabled={!assetId||busy||Date.parse(uncertainSetup.expiresAt)>Date.now()} onClick={()=>void reconcileSetup()}>Check previous setup</Button></div>:null}</>:null}
      {ingressFailure&&setup?.connection?<div className="space-y-2 rounded-md border p-3"><p className="text-sm">{ingressFailure.count} incoming messages need attention.</p>{ingressFailure.reason?<p className="text-xs text-muted-foreground">{ingressFailure.reason}</p>:null}<Button disabled={busy} variant="outline" onClick={()=>{const connection=setup.connection!;setBusy(true);void channelApi(organizationId,`/${connection.id}/retry-ingress`,{expectedRevision:connection.revision}).then(()=>refresh()).catch(cause=>setError(channelError(cause))).finally(()=>setBusy(false));}}>Retry pending messages</Button></div>:null}
      {setup?.connection?.state==="active"&&setup.kind!=="telegram"&&!ticket&&!signup?<form onSubmit={event=>void connect(event)}><Button type="submit" variant="outline" disabled={busy}>Reconnect account</Button></form>:null}
      {signup?<><p className="text-sm">Finish WhatsApp signup, then choose the number to connect.</p><Button disabled={!sdk||busy} onClick={()=>{setError("");sdk?.login(response=>{if(response.authResponse?.code)setSignupCode(response.authResponse.code);else setError("WhatsApp signup cancelled. Try again.");},{config_id:signup.configurationId,response_type:signup.responseType,override_default_response_type:signup.overrideDefaultResponseType,extras:signup.extras,state:signup.state});}}>Continue with Facebook</Button>{!sdk&&!busy?<Button variant="outline" onClick={()=>{setBusy(true);void facebookSdk(signup.appId,signup.apiVersion).then(setSdk).catch(cause=>setError(channelError(cause))).finally(()=>setBusy(false));}}>Reload signup</Button>:null}</>:null}
      {setup&&setup.kind!=="website"&&!ticket&&!signup&&(setup.connection?.state!=="active"||setup.kind==="telegram")?<form onSubmit={event=>void connect(event)} className="space-y-4">
        {!setup.connection?<label className="block space-y-2 text-sm">Connection name<Input required value={name} maxLength={120} onChange={event=>setName(event.target.value)}/></label>:null}
        {setup.kind==="instagram"&&!setup.connection?<label className="block space-y-2 text-sm">Connect with<select aria-label="Instagram login mode" className="min-h-10 w-full rounded-md border bg-background px-3" value={mode} onChange={event=>setMode(event.target.value)}>{definition?.modes.map(item=><option key={item.id} value={item.id} disabled={!item.available}>{modeNames[item.id]??item.id}</option>)}</select></label>:null}
        {setup.kind==="telegram"?<><label className="block space-y-2 text-sm">{setup.connection?"Replacement bot token":"Bot token"}<Input required type="password" autoComplete="new-password" value={secret} onChange={event=>setSecret(event.target.value)}/></label><a className="text-xs underline" href="https://core.telegram.org/bots/tutorial#obtain-your-bot-token" target="_blank" rel="noreferrer">Get a bot token</a></>:null}
        {setup.kind==="whatsapp"?<details onToggle={event=>setManual(event.currentTarget.open)}><summary className="cursor-pointer text-sm">Advanced token setup</summary><div className="mt-3 space-y-3"><label className="block space-y-2 text-sm">Access token<Input type="password" autoComplete="new-password" required={manual} value={secret} onChange={event=>setSecret(event.target.value)}/></label><label className="block space-y-2 text-sm">WhatsApp Business account ID<Input required={manual} value={wabaId} onChange={event=>setWabaId(event.target.value)}/></label></div></details>:null}
        <Button type="submit" disabled={busy||(setup.kind==="telegram"&&!secret.trim())}>{busy?"Connecting…":setup.kind==="telegram"?setup.connection?"Replace token":"Connect bot":manual?"Verify account":setup.kind==="whatsapp"?"Start embedded signup":"Authorize account"}</Button>
      </form>:null}
      {replacement?<div className="space-y-3 rounded-md border p-3"><p className="text-sm">This bot already has a webhook. Replace it only if you control its current connection.</p><Button disabled={busy} variant="outline" onClick={()=>void telegramSetup(replacement)}>Replace existing webhook</Button></div>:null}
      {setup?.connection?.kind==="telegram"&&!replacement&&setup.connection.state!=="active"&&setup.connection.state!=="disconnected"?<Button disabled={busy} variant="outline" onClick={()=>void telegramSetup()}>Retry webhook setup</Button>:null}
      {setup?.connection&&setup.connection.state!=="disconnected"?<div className="flex flex-wrap gap-2 border-t pt-3"><Button disabled={busy} variant="outline" size="sm" onClick={()=>void health()}>Check health</Button><Button disabled={busy} variant="ghost" size="sm" onClick={()=>void disconnect(setup.connection!)}>Disconnect</Button></div>:null}
      {setup?.connection&&["pending","disconnected"].includes(setup.connection.state)?<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void remove(setup.connection!)}>Remove connection</Button>:null}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={close}>Close</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
