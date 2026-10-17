export function websiteWidgetScript(deploymentId: string): string {
  return `(() => {
  const script = document.currentScript;
  if (!script) return;
  const base = new URL(script.src).origin + '/api/website/' + ${JSON.stringify(deploymentId)};
  const host = document.createElement('div');
  const shadow = host.attachShadow({mode:'open'});
  const style = document.createElement('style');
  style.textContent = ':host{position:fixed;bottom:20px;right:20px;z-index:2147483000;font:14px system-ui;color:#172033}button{font:inherit;cursor:pointer;border:0;border-radius:8px;background:#4a46e8;color:white;padding:10px 16px}section{width:min(360px,calc(100vw - 40px));background:white;border:1px solid #dddfe8;border-radius:12px;box-shadow:0 8px 40px #17203322;overflow:hidden}header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #eee;padding:12px 16px}header button{background:transparent;color:#172033;padding:6px}main{height:260px;overflow:auto;padding:12px 16px;white-space:pre-wrap;overflow-wrap:anywhere}p{margin:0 0 12px;line-height:1.5}form{padding:12px;border-top:1px solid #eee;display:flex;gap:8px}input{min-width:0;flex:1;font:inherit;padding:8px;border:1px solid #bbb;border-radius:6px}button:focus-visible,input:focus-visible{outline:2px solid #4a46e8;outline-offset:2px}[hidden]{display:none!important}';
  shadow.append(style);
  const toggle = document.createElement('button'); toggle.textContent='Chat'; toggle.setAttribute('aria-expanded','false');
  const panel = document.createElement('section'); panel.hidden=true; panel.setAttribute('aria-label','Website assistant');
  const header = document.createElement('header'); const title=document.createElement('strong'); title.textContent='Assistant';
  const close=document.createElement('button'); close.type='button';close.textContent='Close';
  header.append(title,close); const log=document.createElement('main'); log.setAttribute('aria-live','polite');
  const form=document.createElement('form');const input=document.createElement('input');input.required=true;input.maxLength=8000;input.placeholder='Ask a question';input.setAttribute('aria-label','Message');
  const send=document.createElement('button');send.type='submit';send.textContent='Send';const retry=document.createElement('button');retry.type='button';retry.textContent='Retry request';retry.hidden=true;form.append(input,send,retry);panel.append(header,log,form);shadow.append(toggle,panel);(document.body||document.documentElement).append(host);
  let token,conversationId;const storageKey='agents-widget:'+base;let state;
  try{state=JSON.parse(sessionStorage.getItem(storageKey)||'null');token=state?.token;conversationId=state?.conversationId}catch{}
  const save=()=>{try{sessionStorage.setItem(storageKey,JSON.stringify(state))}catch{}};
  const paragraph=(label,text)=>{const p=document.createElement('p');const b=document.createElement('strong');b.textContent=label;const content=document.createTextNode(' '+text);p.append(b,content);log.append(p);log.scrollTop=log.scrollHeight;return p};
  async function request(path,body){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',credentials:'omit',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok){const error=new Error(data.error?.message||'Request failed');error.status=response.status;throw error}return data;}
  const terminal=state=>['completed','failed','cancelled','uncertain'].includes(state);
  let following=false;const controls=()=>{const pending=Boolean(state?.requestKey||state?.taskId);send.disabled=following||pending;input.disabled=following||pending;retry.hidden=following||!pending;retry.textContent=state?.taskId?'Reconnect':'Retry request'};
  async function follow(taskId){if(following)return;following=true;controls();const status=paragraph('Assistant:','Thinking…');
    try{for(;;){const {task}=await request('/tasks/'+encodeURIComponent(taskId));if(terminal(task.state)){status.textContent=task.output|| (task.state==='uncertain'?'The request outcome is uncertain.':'The request could not be completed.');conversationId=task.conversationId;state={token,conversationId};save();break;}await new Promise(resolve=>setTimeout(resolve,1200));}}
    catch(error){status.textContent=error.message+' Reconnect to check this task.';}finally{following=false;controls();}}
  let resumed=false;toggle.onclick=async()=>{panel.hidden=false;toggle.hidden=true;toggle.setAttribute('aria-expanded','true');controls();if(!input.disabled)input.focus();if(!resumed){resumed=true;try{const info=await request('');title.textContent=info.name;if(state?.taskId)await follow(state.taskId);else if(state?.requestKey)paragraph('','The request outcome is unknown. Retry the same request to recover it.')}catch(error){paragraph('',error.message)}}};
  close.onclick=()=>{panel.hidden=true;toggle.hidden=false;toggle.setAttribute('aria-expanded','false');toggle.focus()};
  async function submitPending(){if(!state?.requestKey)return;send.disabled=true;input.disabled=true;retry.hidden=true;try{const {task}=await request('/tasks',{input:state.input,requestKey:state.requestKey,...(state.conversationId?{conversationId:state.conversationId}:{})});state={token,conversationId:task.conversationId,taskId:task.id};save();await follow(task.id);}catch(error){paragraph('',error.message);if([400,401,403,404,409,413,422,429].includes(error.status)){input.value=state.input||'';if(error.status===401){token=undefined;conversationId=undefined}state={token,conversationId};save()}controls();}}
  retry.onclick=()=>{if(state?.taskId)void follow(state.taskId);else void submitPending()};
  form.onsubmit=async event=>{event.preventDefault();const text=input.value.trim();if(!text||send.disabled)return;send.disabled=true;input.disabled=true;paragraph('You:',text);input.value='';
    try{if(!token){({token}=await request('/session',{}));state={token,conversationId};save();}state={token,conversationId,requestKey:crypto.randomUUID(),input:text};save();await submitPending();}
    catch(error){paragraph('',error.message);controls();}}
})();`;
}
