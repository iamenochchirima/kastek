//! Anonymous website lead and waitlist transport handlers.

use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::StreamExt;
use serde_json::Value;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::AgentWebsiteVisitorMessageRequest;
use crate::db::models::{ProductWaitlistCreateRequest, QuoteRequestCreateRequest};
use crate::error::AppError;
use crate::services::{agent_platform::AgentPlatformClient, content_media, website};

const WEBSITE_CHAT_LOADER: &str = r#"(() => {
  const script = document.currentScript;
  const deployment = script?.dataset?.kasitekDeployment;
  const share = script?.dataset?.kasitekShare === 'true';
  if (!deployment || window.KasiTekChat?.instances?.[deployment]) return;
  const base = new URL(script.src, window.location.href).origin;
  const api = `${base}/api/widget/v1`;
  const shareSuffix = share ? '?share=1' : '';
  const instance = { open: () => {}, close: () => {} };
  window.KasiTekChat = window.KasiTekChat || { instances: {}, open: (id) => window.KasiTekChat?.instances?.[id]?.open() };
  window.KasiTekChat.instances[deployment] = instance;
  Promise.all([
    fetch(`${api}/deployments/${encodeURIComponent(deployment)}${shareSuffix}`, { credentials: 'omit' }).then((r) => r.ok ? r.json() : Promise.reject(new Error('Website Chat is unavailable'))),
    fetch(`${api}/deployments/${encodeURIComponent(deployment)}/sessions${shareSuffix}`, { method: 'POST', credentials: 'omit' }).then((r) => r.ok ? r.json() : Promise.reject(new Error('Website Chat could not start')))
  ]).then(([config, session]) => {
    const appearance = config.appearance || {};
    const color = appearance.primaryColor || ({ indigo: '#3730a3', violet: '#7c3aed', emerald: '#059669', blue: '#2563eb', slate: '#334155' })[config.colorPreset] || '#3730a3';
    const launcherSize = Number(appearance.launcherSize) || 56;
    const launcherOffset = Number(appearance.launcherOffset) || 16;
    const windowWidth = Number(appearance.windowWidth) || 390;
    const windowHeight = Number(appearance.windowHeight) || 620;
    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.setAttribute('aria-label', `Open ${config.displayName || 'KasiTek'} chat`);
    launcher.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8 8.7 8.7 0 0 1-3.7-.8L4 20l1.3-3.4A8 8 0 1 1 20 11.5Z"></path><path d="M8 11.5h.01M12 11.5h.01M16 11.5h.01"></path></svg>';
    launcher.style.cssText = `position:absolute;z-index:2;width:${launcherSize}px;height:${launcherSize}px;border:0;border-radius:50%;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;background:${color};box-shadow:0 8px 24px #11182740;pointer-events:auto;${config.launcherPosition === 'bottom-right' ? `right:${launcherOffset}px` : `left:${launcherOffset}px`};bottom:${launcherOffset}px`;
    const overlay = document.createElement('div');
    overlay.setAttribute('data-kasitek-chat-overlay', deployment);
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
    overlay.appendChild(launcher);
    const frame = document.createElement('iframe');
    frame.src = `${api}/frame.html`;
    frame.title = `${config.displayName || 'KasiTek'} chat`;
    frame.setAttribute('aria-label', `${config.displayName || 'KasiTek'} chat`);
    frame.style.cssText = `position:absolute;z-index:1;border:0;width:${windowWidth}px;height:${windowHeight}px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);${config.launcherPosition === 'bottom-left' ? `left:${launcherOffset}px` : `right:${launcherOffset}px`};bottom:${launcherOffset}px;display:none;background:transparent;pointer-events:auto`;
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    let ready = false;
    const emit = (payload) => { if (ready) frame.contentWindow?.postMessage(payload, base); };
    const pollAudioStatus = (jobId) => {
      const poll = () => fetch(`${api}/sessions/${encodeURIComponent(session.sessionId)}/audio/${encodeURIComponent(jobId)}${shareSuffix}`, { credentials: 'omit' })
        .then((statusResponse) => statusResponse.ok ? statusResponse.json() : Promise.reject(new Error('Audio status unavailable')))
        .then((status) => {
          emit({ type: 'kasitek:audio-status', jobId, status: status.status, transcript: status.transcript || '', audioUrl: status.audioUrl || '', errorMessage: status.errorMessage || '' });
          if (status.status === 'queued' || status.status === 'processing' || status.status === 'dispatching' || status.status === 'retryable_failed') window.setTimeout(poll, 1000);
        })
        .catch(() => emit({ type: 'kasitek:error', message: 'Unable to track your audio. Please try again.' }));
      poll();
    };
    const retryAudio = (jobId) => fetch(`${api}/sessions/${encodeURIComponent(session.sessionId)}/audio/${encodeURIComponent(jobId)}/retry${shareSuffix}`, { method: 'POST', credentials: 'omit' })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error('Audio retry was not accepted')))
      .then((result) => { emit({ type: 'kasitek:accepted', jobId, status: result.status || 'queued' }); pollAudioStatus(jobId); })
      .catch(() => emit({ type: 'kasitek:error', message: 'Unable to retry your audio. Please try again.' }));
    instance.open = () => { frame.style.display = 'block'; launcher.style.display = 'none'; emit({ type: 'kasitek:open' }); };
    instance.close = () => { frame.style.display = 'none'; launcher.style.display = 'flex'; };
    launcher.addEventListener('click', instance.open);
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || event.origin !== base || !event.data) return;
      if (event.data.type === 'kasitek:ready') { ready = true; emit({ type: 'kasitek:init', config, sessionId: session.sessionId }); }
      if (event.data.type === 'kasitek:close') instance.close();
      if (event.data.type === 'kasitek:send-audio' && event.data.audio instanceof Blob) {
        const audio = event.data.audio;
        const headers = { 'Content-Type': audio.type || 'audio/webm', 'X-Audio-Idempotency-Key': crypto.randomUUID() };
        if (typeof event.data.fileName === 'string' && event.data.fileName.trim()) headers['X-Audio-File-Name'] = encodeURIComponent(event.data.fileName.trim().slice(0, 240));
        fetch(`${api}/sessions/${encodeURIComponent(session.sessionId)}/audio${shareSuffix}`, { method: 'POST', credentials: 'omit', headers, body: audio })
          .then(async (r) => {
            if (!r.ok) throw new Error('Audio not accepted');
            const result = await r.json().catch(() => null);
            const jobId = typeof result?.jobId === 'string' ? result.jobId : '';
            if (!jobId) throw new Error('Audio job was not created');
            emit({ type: 'kasitek:accepted', jobId, status: result.status || 'queued' });
            pollAudioStatus(jobId);
          })
          .catch(() => emit({ type: 'kasitek:error', message: 'Unable to process your audio. Please try again.' }));
      }
      if (event.data.type === 'kasitek:retry-audio' && typeof event.data.jobId === 'string') retryAudio(event.data.jobId);
      if (event.data.type === 'kasitek:send' && typeof event.data.text === 'string') {
        fetch(`${api}/sessions/${encodeURIComponent(session.sessionId)}/messages${shareSuffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), text: event.data.text }) })
          .then((r) => { if (!r.ok) throw new Error('Message not accepted'); emit({ type: 'kasitek:accepted' }); })
          .catch(() => emit({ type: 'kasitek:error', message: 'Unable to send your message. Please try again.' }));
      }
    });
    let after = '';
    setInterval(() => fetch(`${api}/sessions/${encodeURIComponent(session.sessionId)}/deliveries${share ? `?share=1${after ? `&after=${encodeURIComponent(after)}` : ''}` : after ? `?after=${encodeURIComponent(after)}` : ''}`, { credentials: 'omit' })
      .then((r) => r.ok ? r.json() : null).then((result) => result?.deliveries?.forEach((delivery) => { after = delivery.id; emit({ type: 'kasitek:reply', text: delivery.messageText }); })).catch(() => {}), 1500);
  }).catch((error) => console.warn('[KasiTek Chat]', error.message));
})();"#;

const WEBSITE_CHAT_FRAME: &str = r#"<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{box-sizing:border-box}
    html,body{width:100%;height:100%;overflow:hidden}
    body{margin:0;font-family:Inter,system-ui,sans-serif;color:#172033}
    #chat{height:100%;min-height:0;display:flex;flex-direction:column;background:#fff;border:1px solid #d8deea;border-radius:var(--chat-radius,16px);box-shadow:0 18px 50px #11182730;overflow:hidden}
    header{padding:15px 16px;background:var(--chat-primary,#3730a3);color:#fff;font-weight:650;display:flex;justify-content:space-between;flex:0 0 auto}
    button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
    button:disabled,input:disabled{cursor:not-allowed;opacity:.65}
    #messages{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:14px;background:#f8fafc;display:flex;flex-direction:column;gap:9px}
    .m{max-width:88%;padding:10px 12px;border-radius:12px;overflow-wrap:anywhere;word-break:break-word;line-height:1.35}
    .me{align-self:flex-end;background:var(--chat-primary,#3730a3);color:#fff}
    .bot{align-self:flex-start;max-width:92%;background:#e7eaf2}
    .line{min-height:1.35em}
    .line.bullet{padding-left:4px}
    .bot strong{font-weight:700;color:#111827}
    .bot code{padding:1px 4px;border-radius:4px;background:#d7dce8;font-size:.9em}
    .transcript{margin-top:7px;padding-top:7px;border-top:1px solid #ffffff55;font-size:12px;line-height:1.35;opacity:.9}
    .transcript button{margin-left:7px;padding:2px 7px;border:1px solid #ffffff88;border-radius:6px;font-size:11px}
    .audio-player{display:block;width:min(100%,260px);height:32px;margin-bottom:7px}
    .bot table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}
    .bot th,.bot td{padding:7px 8px;border:1px solid #cbd5e1;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
    .bot th{background:#dce2ee;font-weight:700}
    form{display:flex;gap:8px;padding:10px;border-top:1px solid #e2e8f0;flex:0 0 auto}
    input{min-width:0;flex:1;border:1px solid #cbd5e1;border-radius:9px;padding:10px;font:inherit}
    form button{background:var(--chat-primary,#3730a3);color:#fff;border-radius:9px;padding:0 13px;white-space:nowrap}
    #audio-button,#file-button{width:38px;padding:0;background:transparent;color:#475569;font-size:18px}
    #audio-button.recording{color:#b91c1c}
    #file-input{display:none}
    small{display:block;padding:0 12px 10px;color:#64748b;text-align:center;flex:0 0 auto}
    small[hidden]{display:none}
    small a{color:inherit;text-decoration:none}
    small a:hover{text-decoration:underline}
    #error{color:#b91c1c;padding:0 12px 8px;font-size:12px;flex:0 0 auto}
    .typing{display:flex;align-items:center;gap:4px;color:#64748b}
    .typing[hidden]{display:none!important}
    .typing span{margin-right:2px}
    .typing i{width:5px;height:5px;border-radius:50%;background:#64748b;animation:typing-dot 1s infinite ease-in-out}
    .typing i:nth-child(2){animation-delay:.15s}
    .typing i:nth-child(3){animation-delay:.3s}
    .typing i:nth-child(4){animation-delay:.45s}
    @keyframes typing-dot{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
  </style>
</head>
<body>
  <div id="chat">
    <header><span id="name">Chat</span><button id="close" aria-label="Close chat">×</button></header>
    <main id="messages"></main>
    <div id="typing" class="m bot typing" hidden aria-live="polite"><span>Thinking</span><i></i><i></i><i></i></div>
    <div id="error" role="alert"></div>
    <form id="form"><button id="audio-button" type="button" aria-label="Record audio" title="Record audio">●</button><button id="file-button" type="button" aria-label="Attach audio" title="Attach audio">＋</button><input id="file-input" type="file" accept="audio/*"><input id="input" maxlength="4000" placeholder="Type a message…" aria-label="Message"><button id="send-button" type="submit">Send</button></form>
    <small id="branding">Powered by <a href="https://kasitek.co.za" target="_blank" rel="noopener noreferrer">KasiTek</a></small>
  </div>
  <script>
    const q=(selector)=>document.querySelector(selector);
    const messages=q('#messages');
    const input=q('#input');
    const sendButton=q('#send-button');
    const audioButton=q('#audio-button');
    const fileButton=q('#file-button');
    const fileInput=q('#file-input');
    const typing=q('#typing');
    const error=q('#error');
    const parentOrigin=(()=>{try{return new URL(document.referrer).origin}catch{return ''}})();
    const targetOrigin=parentOrigin||'*';
    let pending=false;
    let pendingTimer=null;
    let recorder=null;
    let stream=null;
    let recordedChunks=[];
    let pendingAudioMessage=null;

    const scrollToBottom=()=>requestAnimationFrame(()=>{messages.scrollTop=messages.scrollHeight});
    const appendPlain=(parent,text)=>{
      String(text).replace(/<br\s*\/?\s*>/gi,'\n').split('\n').forEach((part,index)=>{
        if(index)parent.append(document.createElement('br'));
        parent.append(document.createTextNode(part));
      });
    };
    const appendInline=(parent,text)=>{
      const source=String(text);
      const pattern=/(\*\*[^*]+\*\*|`[^`]+`)/g;
      let last=0;
      let match;
      while((match=pattern.exec(source))!==null){
        appendPlain(parent,source.slice(last,match.index));
        const token=match[0];
        const element=document.createElement(token.startsWith('**')?'strong':'code');
        element.textContent=token.startsWith('**')?token.slice(2,-2):token.slice(1,-1);
        parent.append(element);
        last=pattern.lastIndex;
      }
      appendPlain(parent,source.slice(last));
    };
    const appendLine=(parent,text)=>{
      const line=document.createElement('div');
      const bullet=String(text).match(/^\s*(?:[•*-])\s+(.+)$/);
      line.className=bullet?'line bullet':'line';
      appendInline(line,bullet?`• ${bullet[1]}`:text);
      parent.append(line);
    };
    const rowCells=(line)=>{
      let value=String(line).trim();
      if(value.startsWith('|'))value=value.slice(1);
      if(value.endsWith('|'))value=value.slice(0,-1);
      return value.split('|').map((cell)=>cell.trim());
    };
    const isTableSeparator=(line)=>/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line));
    const appendTable=(parent,lines,start)=>{
      const table=document.createElement('table');
      const head=document.createElement('thead');
      const headRow=document.createElement('tr');
      rowCells(lines[start]).forEach((cell)=>{const element=document.createElement('th');appendInline(element,cell);headRow.append(element)});
      head.append(headRow);
      table.append(head);
      const body=document.createElement('tbody');
      let index=start+2;
      while(index<lines.length&&lines[index].trim()&&lines[index].includes('|')&&!isTableSeparator(lines[index])){
        const row=document.createElement('tr');
        rowCells(lines[index]).forEach((cell)=>{const element=document.createElement('td');appendInline(element,cell);row.append(element)});
        body.append(row);
        index+=1;
      }
      table.append(body);
      parent.append(table);
      return index;
    };
    const appendFormatted=(parent,text)=>{
      const lines=String(text??'').replace(/\r\n?/g,'\n').split('\n');
      let hasContent=false;
      for(let index=0;index<lines.length;index+=1){
        const line=lines[index];
        if(line.trim()===''){
          if(hasContent){const spacer=document.createElement('div');spacer.className='line';spacer.innerHTML='&nbsp;';parent.append(spacer)}
          continue;
        }
        if(line.includes('|')&&isTableSeparator(lines[index+1]||'')){
          index=appendTable(parent,lines,index)-1;
          hasContent=true;
          continue;
        }
        appendLine(parent,line);
        hasContent=true;
      }
    };
    const add=(text,kind)=>{
      const element=document.createElement('div');
      element.className='m '+kind;
      if(kind==='bot')appendFormatted(element,text);else appendInline(element,text);
      messages.append(element);
      scrollToBottom();
      return element;
    };
    const stopPending=()=>{
      pending=false;
      typing.hidden=true;
      input.disabled=false;
      sendButton.disabled=false;
      audioButton.disabled=false;
      fileButton.disabled=false;
      sendButton.textContent='Send';
      if(pendingTimer){window.clearTimeout(pendingTimer);pendingTimer=null}
    };
    const startPending=()=>{
      pending=true;
      typing.hidden=false;
      input.disabled=true;
      sendButton.disabled=true;
      audioButton.disabled=true;
      fileButton.disabled=true;
      sendButton.textContent='Sending…';
      scrollToBottom();
      if(pendingTimer)window.clearTimeout(pendingTimer);
      pendingTimer=window.setTimeout(()=>{
        if(!pending)return;
        stopPending();
        error.textContent='The agent is taking longer than expected. Please try again.';
        scrollToBottom();
      },45000);
    };
    const sendAudio=(audio,fileName)=>{
      if(pending)return;
      error.textContent='';
      pendingAudioMessage=add('Audio message','me');
      startPending();
      parent.postMessage({type:'kasitek:send-audio',audio,fileName},targetOrigin);
    };
    const stopTracks=()=>{if(stream){stream.getTracks().forEach((track)=>track.stop());stream=null}recorder=null;audioButton.classList.remove('recording');audioButton.textContent='●';audioButton.setAttribute('aria-label','Record audio');audioButton.title='Record audio'};
    const supportedRecordingType=()=>{if(typeof MediaRecorder==='undefined')return '';return ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg'].find((value)=>MediaRecorder.isTypeSupported(value))||''};
    audioButton.onclick=async()=>{
      if(pending)return;
      if(recorder){recorder.stop();return}
      if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){error.textContent='Audio recording is not supported in this browser';return}
      try{
        stream=await navigator.mediaDevices.getUserMedia({audio:true});
        const type=supportedRecordingType();
        recorder=new MediaRecorder(stream,type?{mimeType:type}:undefined);
        recordedChunks=[];
        recorder.ondataavailable=(event)=>{if(event.data.size)recordedChunks.push(event.data)};
        recorder.onerror=()=>{stopTracks();error.textContent='Audio recording failed'};
        recorder.onstop=()=>{const mime=recorder.mimeType||type||'audio/webm';const blob=new Blob(recordedChunks,{type:mime});stopTracks();if(blob.size)sendAudio(blob,`website-recording.${mime.includes('ogg')?'ogg':'webm'}`);else error.textContent='No audio was recorded'};
        recorder.start();
        audioButton.classList.add('recording');audioButton.textContent='■';audioButton.setAttribute('aria-label','Stop recording');audioButton.title='Stop recording';
      }catch(errorValue){stopTracks();error.textContent=errorValue?.name==='NotAllowedError'?'Microphone permission is required':'Unable to access the microphone'}
    };
    fileButton.onclick=()=>{if(!pending)fileInput.click()};
    fileInput.onchange=()=>{const file=fileInput.files?.[0];fileInput.value='';if(file)sendAudio(file,file.name)};

    window.addEventListener('message',(event)=>{
      if((parentOrigin&&event.origin!==parentOrigin)||!event.data)return;
      const data=event.data;
      if(data.type==='kasitek:init'){
        q('#name').textContent=data.config.displayName||'Chat';
        const appearance=data.config.appearance||{};
        const root=document.documentElement;
        if(typeof appearance.primaryColor==='string')root.style.setProperty('--chat-primary',appearance.primaryColor);
        if(Number.isFinite(Number(appearance.borderRadius)))root.style.setProperty('--chat-radius',`${appearance.borderRadius}px`);
        q('#branding').hidden=appearance.showBranding===false;
        if(data.config.welcomeText)add(data.config.welcomeText,'bot');
      }
      if(data.type==='kasitek:accepted'){
        error.textContent='';
        if(pendingAudioMessage){const transcript=pendingAudioMessage.querySelector('.transcript');if(transcript)transcript.textContent='Transcribing…';else{const next=document.createElement('div');next.className='transcript';next.textContent='Transcribing…';pendingAudioMessage.append(next)}}
      }
      if(data.type==='kasitek:audio-status'&&pendingAudioMessage){
        const transcript=pendingAudioMessage.querySelector('.transcript');
        if(typeof data.audioUrl==='string'&&data.audioUrl){let player=pendingAudioMessage.querySelector('audio');if(!player){player=document.createElement('audio');player.controls=true;player.preload='metadata';player.className='audio-player';pendingAudioMessage.prepend(player)}player.src=data.audioUrl}
        if(data.status==='completed'&&data.transcript){if(transcript)transcript.textContent=`Transcript: ${data.transcript}`;pendingAudioMessage=null}
        else if(data.status==='failed'){
          stopPending();
          if(transcript){transcript.textContent=data.errorMessage||'Unable to transcribe your audio';const retry=document.createElement('button');retry.type='button';retry.textContent='Try again';retry.onclick=()=>{startPending();error.textContent='';parent.postMessage({type:'kasitek:retry-audio',jobId:data.jobId},targetOrigin)};transcript.append(retry)}
          else error.textContent=data.errorMessage||'Unable to transcribe your audio';
          scrollToBottom()
        }
      }
      if(data.type==='kasitek:reply'){
        stopPending();
        add(data.text,'bot');
      }
      if(data.type==='kasitek:error'){
        stopPending();
        error.textContent=data.message||'Something went wrong';
        scrollToBottom();
      }
    });
    q('#close').onclick=()=>parent.postMessage({type:'kasitek:close'},targetOrigin);
    q('#form').onsubmit=(event)=>{
      event.preventDefault();
      if(pending)return;
      const value=input.value.trim();
      if(!value)return;
      error.textContent='';
      add(value,'me');
      input.value='';
      startPending();
      parent.postMessage({type:'kasitek:send',text:value},targetOrigin);
    };
    parent.postMessage({type:'kasitek:ready'},targetOrigin);
  </script>
</body>
</html>"#;

fn website_channel_message_payload(
    channel_key: &str,
    provider_event_id: &str,
    external_identity: &str,
    external_conversation_id: &str,
    text: &str,
    display_name: Option<&str>,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "channelType": "website",
        "channelKey": channel_key,
        "provider": "kasitek-website",
        "providerEventId": provider_event_id,
        "providerMessageId": provider_event_id,
        "externalIdentity": external_identity,
        "externalConversationId": external_conversation_id,
        "messageType": "text",
        "content": { "text": text },
    });
    if let Some(display_name) = display_name {
        payload["displayName"] = serde_json::Value::String(display_name.to_string());
    }
    payload
}

fn website_channel_audio_payload(
    channel_key: &str,
    installation_id: &str,
    provider_event_id: &str,
    external_identity: &str,
    external_conversation_id: &str,
    text: &str,
    asset_id: &str,
    mime_type: &str,
    file_name: Option<&str>,
    display_name: Option<&str>,
) -> Value {
    let mut content = serde_json::json!({
        "text": text,
        "assetId": asset_id,
        "mimeType": mime_type,
        "mediaKind": "audio",
        "transcription": { "status": "queued", "provider": "elevenlabs" },
    });
    if let Some(file_name) = file_name {
        content["fileName"] = Value::String(file_name.to_string());
    }
    let mut payload = serde_json::json!({
        "channelType": "website",
        "channelKey": channel_key,
        "installationId": installation_id,
        "provider": "kasitek-website",
        "providerEventId": provider_event_id,
        "providerMessageId": provider_event_id,
        "externalIdentity": external_identity,
        "externalConversationId": external_conversation_id,
        "messageType": "attachment",
        "content": content,
    });
    if let Some(display_name) = display_name {
        payload["displayName"] = Value::String(display_name.to_string());
    }
    payload
}

pub async fn create_quote_request(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<QuoteRequestCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let result =
        website::create_quote_request(pool.get_ref(), config.get_ref(), body.into_inner()).await?;
    Ok(HttpResponse::Created().json(result))
}

pub async fn agent_website_chat_loader() -> HttpResponse {
    HttpResponse::Ok()
        .insert_header(("Content-Type", "application/javascript; charset=utf-8"))
        .insert_header(("Cache-Control", "public, max-age=300"))
        .body(WEBSITE_CHAT_LOADER)
}

pub async fn agent_website_chat_frame() -> HttpResponse {
    HttpResponse::Ok()
        .insert_header(("Content-Type", "text/html; charset=utf-8"))
        .insert_header(("Cache-Control", "no-store"))
        .body(WEBSITE_CHAT_FRAME)
}

pub async fn agent_website_chat_share(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    public_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let share_origin = website::normalize_origin(&config.public_api_url)?;
    website::public_agent_website_deployment(pool.get_ref(), public_id.trim(), &share_origin, true)
        .await?;
    let api_base = config.public_api_url.trim_end_matches('/');
    let public_id = public_id.trim();
    let html = format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website Chat</title>
<style>html,body{{min-height:100%;margin:0}}body{{min-height:100vh;background:#f8fafc}}</style></head>
<body><script async src="{api_base}/api/widget/v1/loader.js" data-kasitek-deployment="{public_id}" data-kasitek-share="true"></script></body></html>"#
    );
    Ok(HttpResponse::Ok()
        .insert_header(("Content-Type", "text/html; charset=utf-8"))
        .insert_header(("Cache-Control", "no-store"))
        .body(html))
}

pub async fn agent_website_chat_preflight(req: HttpRequest) -> Result<HttpResponse, AppError> {
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    Ok(HttpResponse::NoContent()
        .insert_header((
            "Access-Control-Allow-Origin",
            website::normalize_origin(origin)?,
        ))
        .insert_header(("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
        .insert_header((
            "Access-Control-Allow-Headers",
            "Content-Type, X-Audio-Idempotency-Key, X-Audio-File-Name, X-Audio-Caption, X-Audio-Display-Name",
        ))
        .insert_header(("Vary", "Origin"))
        .finish())
}

pub async fn create_waitlist_entry(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    body: web::Json<ProductWaitlistCreateRequest>,
) -> Result<HttpResponse, AppError> {
    let result =
        website::create_waitlist_entry(pool.get_ref(), config.get_ref(), body.into_inner()).await?;
    Ok(HttpResponse::Created().json(result))
}

/// Safe bootstrap configuration for the browser loader. The public deployment
/// id is intentionally not a credential; the request origin remains part of
/// the authorization decision.
pub async fn get_agent_website_chat_config(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    public_id: web::Path<String>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let share_request = query
        .get("share")
        .is_some_and(|value| value == "1" || value == "true");
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| share_request.then(|| config.public_api_url.clone()))
        .ok_or_else(|| AppError::Unauthorized)?;
    let normalized_origin = website::normalize_origin(&origin)?;
    let share_origin = website::normalize_origin(&config.public_api_url)?;
    let deployment = website::public_agent_website_deployment(
        pool.get_ref(),
        public_id.trim(),
        &origin,
        share_request && normalized_origin == share_origin,
    )
    .await?;
    Ok(HttpResponse::Ok()
        .insert_header(("Access-Control-Allow-Origin", normalized_origin))
        .insert_header(("Vary", "Origin"))
        .json(serde_json::json!({
            "publicId": deployment.public_id,
            "displayName": deployment.display_name,
            "welcomeText": deployment.welcome_text,
            "launcherPosition": deployment.launcher_position,
            "colorPreset": deployment.color_preset,
            "appearance": deployment.appearance,
            "avatarUrl": deployment.avatar_url,
            "privacyPolicyUrl": deployment.privacy_policy_url,
            "poweredBy": "KasiTek",
        })))
}

pub async fn create_agent_website_chat_session(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    public_id: web::Path<String>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let share_request = query
        .get("share")
        .is_some_and(|value| value == "1" || value == "true");
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| share_request.then(|| config.public_api_url.clone()))
        .ok_or(AppError::Unauthorized)?;
    let normalized_origin = website::normalize_origin(&origin)?;
    let share_origin = website::normalize_origin(&config.public_api_url)?;
    let deployment = website::public_agent_website_deployment(
        pool.get_ref(),
        public_id.trim(),
        &origin,
        share_request && normalized_origin == share_origin,
    )
    .await?;
    let session =
        website::create_agent_website_visitor_session(pool.get_ref(), &deployment, &origin).await?;
    Ok(HttpResponse::Created()
        .insert_header(("Access-Control-Allow-Origin", normalized_origin))
        .insert_header(("Vary", "Origin"))
        .json(serde_json::json!({ "sessionId": session.public_session_id, "expiresAt": session.expires_at })))
}

pub async fn send_agent_website_chat_message(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    session_id: web::Path<String>,
    body: web::Json<AgentWebsiteVisitorMessageRequest>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let share_request = query
        .get("share")
        .is_some_and(|value| value == "1" || value == "true");
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| share_request.then(|| config.public_api_url.clone()))
        .ok_or(AppError::Unauthorized)?;
    let input = body.into_inner();
    let text = input.text.trim();
    if text.is_empty()
        || text.len() > 4_000
        || input.idempotency_key.trim().is_empty()
        || input.idempotency_key.len() > 240
    {
        return Err(AppError::BadRequest(
            "Website Chat message is invalid".to_string(),
        ));
    }
    let session =
        website::active_agent_website_visitor_session(pool.get_ref(), session_id.trim(), &origin)
            .await?;
    let deployment = sqlx::query_scalar::<_, String>(
        r#"SELECT "publicId" FROM "AgentWebsiteDeployment" WHERE id = $1 AND status = 'ACTIVE'"#,
    )
    .bind(&session.deployment_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("Website Chat deployment not found".to_string()))?;
    let display_name = input
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let payload = website_channel_message_payload(
        &deployment,
        &input.idempotency_key,
        &session.external_identity,
        &session.external_conversation_id,
        text,
        display_name,
    );
    let accepted = AgentPlatformClient::from_config(config.get_ref())?
        .ingest_channel_message(
            &sqlx::query_scalar::<_, String>(
                r#"SELECT "orgId" FROM "AgentWebsiteDeployment" WHERE id = $1"#,
            )
            .bind(&session.deployment_id)
            .fetch_one(pool.get_ref())
            .await?,
            &format!("website-session:{}", session.public_session_id),
            payload,
        )
        .await?;
    Ok(HttpResponse::Accepted()
        .insert_header((
            "Access-Control-Allow-Origin",
            website::normalize_origin(&origin)?,
        ))
        .insert_header(("Vary", "Origin"))
        .json(accepted))
}

pub async fn send_agent_website_chat_audio(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    session_id: web::Path<String>,
    mut body: web::Payload,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
    let share_request = query
        .get("share")
        .is_some_and(|value| value == "1" || value == "true");
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| share_request.then(|| config.public_api_url.clone()))
        .ok_or(AppError::Unauthorized)?;
    let normalized_origin = website::normalize_origin(&origin)?;
    let idempotency_key = req
        .headers()
        .get("x-audio-idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| (8..=240).contains(&value.len()))
        .ok_or_else(|| {
            AppError::BadRequest("A valid audio idempotency key is required".to_string())
        })?;
    let mime_type = req
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| {
            matches!(
                *value,
                "audio/aac"
                    | "audio/flac"
                    | "audio/m4a"
                    | "audio/mp4"
                    | "audio/mpeg"
                    | "audio/ogg"
                    | "audio/opus"
                    | "audio/wav"
                    | "audio/webm"
                    | "application/ogg"
            )
        })
        .ok_or_else(|| AppError::BadRequest("A supported audio MIME type is required".to_string()))?
        .to_ascii_lowercase();
    let file_name = req
        .headers()
        .get("x-audio-file-name")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| urlencoding::decode(value).ok())
        .map(|value| value.into_owned());
    let caption = req
        .headers()
        .get("x-audio-caption")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if caption
        .as_deref()
        .is_some_and(|value| value.chars().count() > 4_000)
    {
        return Err(AppError::BadRequest(
            "Audio caption is too long".to_string(),
        ));
    }
    let display_name = req
        .headers()
        .get("x-audio-display-name")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= 120)
        .map(str::to_string);
    let mut bytes = Vec::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|_| AppError::BadRequest("Failed to read audio".to_string()))?;
        if bytes.len() + chunk.len() > MAX_AUDIO_BYTES {
            return Err(AppError::BadRequest(
                "Audio must be 25 MB or smaller".to_string(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(AppError::BadRequest("Audio is required".to_string()));
    }

    let session =
        website::active_agent_website_visitor_session(pool.get_ref(), session_id.trim(), &origin)
            .await?;
    let deployment = sqlx::query_as::<_, (String, String, String, String)>(
        r#"SELECT deployment."orgId", organization."ownerId", deployment."publicId", deployment."installationId"
           FROM "AgentWebsiteDeployment" deployment
           JOIN "Organization" organization ON organization.id = deployment."orgId"
           WHERE deployment.id = $1 AND deployment.status = 'ACTIVE'"#,
    )
    .bind(&session.deployment_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("Website Chat deployment not found".to_string()))?;
    let (organization_id, owner_id, public_id, installation_id) = deployment;
    let source_prefix = format!("website:{public_id}:{}:%", session.public_session_id);
    let recent_audio_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*)
           FROM "ContentMediaAsset"
           WHERE "orgId" = $1
             AND metadata->>'source' = 'website_widget'
             AND metadata->>'sourceKey' LIKE $2
             AND "createdAt" > NOW() - INTERVAL '1 hour'"#,
    )
    .bind(&organization_id)
    .bind(source_prefix)
    .fetch_one(pool.get_ref())
    .await?;
    if recent_audio_count >= 20 {
        return Err(AppError::TooManyRequests(
            "Website Chat audio upload limit reached".to_string(),
        ));
    }
    let source_key = format!(
        "website:{}:{}:{}",
        public_id, session.public_session_id, idempotency_key
    );
    let asset = content_media::upload_content_media_bytes(
        pool.get_ref(),
        config.get_ref(),
        &owner_id,
        &organization_id,
        content_media::ContentMediaBytesUpload {
            file_name: file_name.clone(),
            mime_type: mime_type.clone(),
            bytes,
            source: "website_widget".to_string(),
            source_key: Some(source_key),
        },
    )
    .await?;
    let text = caption.as_deref().unwrap_or("");
    let payload = website_channel_audio_payload(
        &public_id,
        &installation_id,
        idempotency_key,
        &session.external_identity,
        &session.external_conversation_id,
        text,
        &asset.id,
        &mime_type,
        file_name.as_deref(),
        display_name.as_deref(),
    );
    let accepted = AgentPlatformClient::from_config(config.get_ref())?
        .ingest_channel_message(&organization_id, &owner_id, payload)
        .await?;
    Ok(HttpResponse::Accepted()
        .insert_header(("Access-Control-Allow-Origin", normalized_origin))
        .insert_header(("Vary", "Origin"))
        .json(accepted))
}

pub async fn get_agent_website_chat_audio_status(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let share_request = query
        .get("share")
        .is_some_and(|value| value == "1" || value == "true");
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| share_request.then(|| config.public_api_url.clone()))
        .ok_or(AppError::Unauthorized)?;
    let normalized_origin = website::normalize_origin(&origin)?;
    let (session_id, job_id) = path.into_inner();
    let session =
        website::active_agent_website_visitor_session(pool.get_ref(), session_id.trim(), &origin)
            .await?;
    let (organization_id, owner_id, public_id) = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT deployment."orgId", organization."ownerId", deployment."publicId"
           FROM "AgentWebsiteDeployment" deployment
           JOIN "Organization" organization ON organization.id = deployment."orgId"
           WHERE deployment.id = $1 AND deployment.status = 'ACTIVE'"#,
    )
    .bind(&session.deployment_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("Website Chat deployment not found".to_string()))?;
    let client = AgentPlatformClient::from_config(config.get_ref())?;
    let mut status = client
        .get_audio_transcription_job(&organization_id, &owner_id, job_id.trim())
        .await?;
    let asset_id = status
        .get("assetId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::NotFound("Website Chat audio not found".to_string()))?;
    let source_prefix = format!("website:{public_id}:{}:", session.public_session_id);
    let belongs_to_session = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
             SELECT 1 FROM "ContentMediaAsset"
             WHERE id = $1 AND "orgId" = $2
               AND metadata->>'source' = 'website_widget'
               AND metadata->>'sourceKey' LIKE $3
           )"#,
    )
    .bind(asset_id)
    .bind(&organization_id)
    .bind(format!("{source_prefix}%"))
    .fetch_one(pool.get_ref())
    .await?;
    if !belongs_to_session {
        return Err(AppError::NotFound(
            "Website Chat audio not found".to_string(),
        ));
    }
    if let Some(payload) = status.as_object_mut() {
        payload.insert(
            "audioUrl".to_string(),
            Value::String(content_media::public_media_url(config.get_ref(), asset_id)),
        );
    }
    Ok(HttpResponse::Ok()
        .insert_header(("Access-Control-Allow-Origin", normalized_origin))
        .insert_header(("Vary", "Origin"))
        .json(status))
}

pub async fn retry_agent_website_chat_audio(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    path: web::Path<(String, String)>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let share_request = query
        .get("share")
        .is_some_and(|value| value == "1" || value == "true");
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| share_request.then(|| config.public_api_url.clone()))
        .ok_or(AppError::Unauthorized)?;
    let normalized_origin = website::normalize_origin(&origin)?;
    let (session_id, job_id) = path.into_inner();
    let session =
        website::active_agent_website_visitor_session(pool.get_ref(), session_id.trim(), &origin)
            .await?;
    let (organization_id, owner_id, public_id) = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT deployment."orgId", organization."ownerId", deployment."publicId"
           FROM "AgentWebsiteDeployment" deployment
           JOIN "Organization" organization ON organization.id = deployment."orgId"
           WHERE deployment.id = $1 AND deployment.status = 'ACTIVE'"#,
    )
    .bind(&session.deployment_id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or_else(|| AppError::NotFound("Website Chat deployment not found".to_string()))?;
    let client = AgentPlatformClient::from_config(config.get_ref())?;
    let status = client
        .get_audio_transcription_job(&organization_id, &owner_id, job_id.trim())
        .await?;
    let asset_id = status
        .get("assetId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::NotFound("Website Chat audio not found".to_string()))?;
    let source_prefix = format!("website:{public_id}:{}:", session.public_session_id);
    let belongs_to_session = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
             SELECT 1 FROM "ContentMediaAsset"
             WHERE id = $1 AND "orgId" = $2
               AND metadata->>'source' = 'website_widget'
               AND metadata->>'sourceKey' LIKE $3
           )"#,
    )
    .bind(asset_id)
    .bind(&organization_id)
    .bind(format!("{source_prefix}%"))
    .fetch_one(pool.get_ref())
    .await?;
    if !belongs_to_session {
        return Err(AppError::NotFound(
            "Website Chat audio not found".to_string(),
        ));
    }
    let response = client
        .retry_audio_transcription(&organization_id, &owner_id, job_id.trim())
        .await?;
    Ok(HttpResponse::Accepted()
        .insert_header(("Access-Control-Allow-Origin", normalized_origin))
        .insert_header(("Vary", "Origin"))
        .json(response))
}

#[cfg(test)]
mod tests {
    use super::{website_channel_audio_payload, website_channel_message_payload};

    #[test]
    fn omits_optional_display_name_when_not_provided() {
        let payload = website_channel_message_payload(
            "wdg_test",
            "event-1",
            "website:wvs_test",
            "website:wdg_test:wvs_test",
            "Hello",
            None,
        );

        assert!(!payload
            .as_object()
            .expect("payload object")
            .contains_key("displayName"));
    }

    #[test]
    fn includes_trimmed_display_name_when_provided() {
        let payload = website_channel_message_payload(
            "wdg_test",
            "event-1",
            "website:wvs_test",
            "website:wdg_test:wvs_test",
            "Hello",
            Some("Enoch"),
        );

        assert_eq!(payload["displayName"], "Enoch");
    }

    #[test]
    fn audio_payload_starts_queued_transcription_with_internal_asset_reference() {
        let payload = website_channel_audio_payload(
            "wdg_test",
            "installation-1",
            "event-2",
            "website:wvs_test",
            "website:wdg_test:wvs_test",
            "Please call me back",
            "asset-1",
            "audio/webm",
            Some("recording.webm"),
            None,
        );

        assert_eq!(payload["messageType"], "attachment");
        assert_eq!(payload["content"]["assetId"], "asset-1");
        assert_eq!(payload["content"]["mediaKind"], "audio");
        assert_eq!(payload["content"]["transcription"]["status"], "queued");
        assert!(!payload.as_object().unwrap().contains_key("displayName"));
    }
}

pub async fn list_agent_website_chat_deliveries(
    pool: web::Data<PgPool>,
    config: web::Data<AppConfig>,
    req: HttpRequest,
    session_id: web::Path<String>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let share_request = query
        .get("share")
        .is_some_and(|value| value == "1" || value == "true");
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| share_request.then(|| config.public_api_url.clone()))
        .ok_or(AppError::Unauthorized)?;
    let session =
        website::active_agent_website_visitor_session(pool.get_ref(), session_id.trim(), &origin)
            .await?;
    let deliveries = website::list_agent_website_deliveries(
        pool.get_ref(),
        &session,
        query.get("after").map(String::as_str),
    )
    .await?;
    let normalized_origin = website::normalize_origin(&origin)?;
    Ok(HttpResponse::Ok()
        .insert_header(("Access-Control-Allow-Origin", normalized_origin))
        .insert_header(("Vary", "Origin"))
        .json(serde_json::json!({ "deliveries": deliveries })))
}
