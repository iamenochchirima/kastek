//! Anonymous website lead and waitlist transport handlers.

use actix_web::{web, HttpRequest, HttpResponse};
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::db::models::AgentWebsiteVisitorMessageRequest;
use crate::db::models::{ProductWaitlistCreateRequest, QuoteRequestCreateRequest};
use crate::error::AppError;
use crate::services::{agent_platform::AgentPlatformClient, website};

const WEBSITE_CHAT_LOADER: &str = r#"(() => {
  const script = document.currentScript;
  const deployment = script?.dataset?.kasitekDeployment;
  if (!deployment || window.KasiTekChat?.instances?.[deployment]) return;
  const base = new URL(script.src, window.location.href).origin;
  const api = `${base}/api/widget/v1`;
  const instance = { open: () => {}, close: () => {} };
  window.KasiTekChat = window.KasiTekChat || { instances: {}, open: (id) => window.KasiTekChat?.instances?.[id]?.open() };
  window.KasiTekChat.instances[deployment] = instance;
  Promise.all([
    fetch(`${api}/deployments/${encodeURIComponent(deployment)}`, { credentials: 'omit' }).then((r) => r.ok ? r.json() : Promise.reject(new Error('Website Chat is unavailable'))),
    fetch(`${api}/deployments/${encodeURIComponent(deployment)}/sessions`, { method: 'POST', credentials: 'omit' }).then((r) => r.ok ? r.json() : Promise.reject(new Error('Website Chat could not start')))
  ]).then(([config, session]) => {
    const color = ({ indigo: '#3730a3', violet: '#7c3aed', emerald: '#059669', blue: '#2563eb', slate: '#334155' })[config.colorPreset] || '#3730a3';
    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.setAttribute('aria-label', `Open ${config.displayName || 'KasiTek'} chat`);
    launcher.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8 8.7 8.7 0 0 1-3.7-.8L4 20l1.3-3.4A8 8 0 1 1 20 11.5Z"></path><path d="M8 11.5h.01M12 11.5h.01M16 11.5h.01"></path></svg>';
    launcher.style.cssText = `position:absolute;z-index:2;width:56px;height:56px;border:0;border-radius:50%;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;background:${color};box-shadow:0 8px 24px #11182740;pointer-events:auto;${config.launcherPosition === 'bottom-right' ? 'right:16px' : 'left:16px'};bottom:16px`;
    const overlay = document.createElement('div');
    overlay.setAttribute('data-kasitek-chat-overlay', deployment);
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
    overlay.appendChild(launcher);
    const frame = document.createElement('iframe');
    frame.src = `${api}/frame.html`;
    frame.title = `${config.displayName || 'KasiTek'} chat`;
    frame.setAttribute('aria-label', `${config.displayName || 'KasiTek'} chat`);
    frame.style.cssText = `position:absolute;z-index:1;border:0;width:390px;height:620px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);${config.launcherPosition === 'bottom-left' ? 'left:12px' : 'right:12px'};bottom:12px;display:none;background:transparent;pointer-events:auto`;
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    let ready = false;
    const emit = (payload) => { if (ready) frame.contentWindow?.postMessage(payload, base); };
    instance.open = () => { frame.style.display = 'block'; launcher.style.display = 'none'; emit({ type: 'kasitek:open' }); };
    instance.close = () => { frame.style.display = 'none'; launcher.style.display = 'flex'; };
    launcher.addEventListener('click', instance.open);
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || event.origin !== base || !event.data) return;
      if (event.data.type === 'kasitek:ready') { ready = true; emit({ type: 'kasitek:init', config, sessionId: session.sessionId }); }
      if (event.data.type === 'kasitek:close') instance.close();
      if (event.data.type === 'kasitek:send' && typeof event.data.text === 'string') {
        fetch(`${api}/sessions/${encodeURIComponent(session.sessionId)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), text: event.data.text }) })
          .then((r) => { if (!r.ok) throw new Error('Message not accepted'); emit({ type: 'kasitek:accepted' }); })
          .catch(() => emit({ type: 'kasitek:error', message: 'Unable to send your message. Please try again.' }));
      }
    });
    let after = '';
    setInterval(() => fetch(`${api}/sessions/${encodeURIComponent(session.sessionId)}/deliveries${after ? `?after=${encodeURIComponent(after)}` : ''}`, { credentials: 'omit' })
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
    #chat{height:100%;min-height:0;display:flex;flex-direction:column;background:#fff;border:1px solid #d8deea;border-radius:16px;box-shadow:0 18px 50px #11182730;overflow:hidden}
    header{padding:15px 16px;background:#3730a3;color:#fff;font-weight:650;display:flex;justify-content:space-between;flex:0 0 auto}
    button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
    button:disabled,input:disabled{cursor:not-allowed;opacity:.65}
    #messages{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:14px;background:#f8fafc;display:flex;flex-direction:column;gap:9px}
    .m{max-width:88%;padding:10px 12px;border-radius:12px;overflow-wrap:anywhere;word-break:break-word;line-height:1.35}
    .me{align-self:flex-end;background:#3730a3;color:#fff}
    .bot{align-self:flex-start;max-width:92%;background:#e7eaf2}
    .line{min-height:1.35em}
    .line.bullet{padding-left:4px}
    .bot strong{font-weight:700;color:#111827}
    .bot code{padding:1px 4px;border-radius:4px;background:#d7dce8;font-size:.9em}
    .bot table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}
    .bot th,.bot td{padding:7px 8px;border:1px solid #cbd5e1;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
    .bot th{background:#dce2ee;font-weight:700}
    form{display:flex;gap:8px;padding:10px;border-top:1px solid #e2e8f0;flex:0 0 auto}
    input{min-width:0;flex:1;border:1px solid #cbd5e1;border-radius:9px;padding:10px;font:inherit}
    form button{background:#3730a3;color:#fff;border-radius:9px;padding:0 13px;white-space:nowrap}
    small{display:block;padding:0 12px 10px;color:#64748b;text-align:center;flex:0 0 auto}
    #error{color:#b91c1c;padding:0 12px 8px;font-size:12px;flex:0 0 auto}
    .typing{display:flex;align-items:center;gap:4px;color:#64748b}
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
    <form id="form"><input id="input" maxlength="4000" placeholder="Type a message…" aria-label="Message"><button id="send-button" type="submit">Send</button></form>
    <small>Powered by KasiTek</small>
  </div>
  <script>
    const q=(selector)=>document.querySelector(selector);
    const messages=q('#messages');
    const input=q('#input');
    const sendButton=q('#send-button');
    const typing=q('#typing');
    const error=q('#error');
    const parentOrigin=(()=>{try{return new URL(document.referrer).origin}catch{return ''}})();
    const targetOrigin=parentOrigin||'*';
    let pending=false;
    let pendingTimer=null;

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
      sendButton.textContent='Send';
      if(pendingTimer){window.clearTimeout(pendingTimer);pendingTimer=null}
    };
    const startPending=()=>{
      pending=true;
      typing.hidden=false;
      input.disabled=true;
      sendButton.disabled=true;
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

    window.addEventListener('message',(event)=>{
      if((parentOrigin&&event.origin!==parentOrigin)||!event.data)return;
      const data=event.data;
      if(data.type==='kasitek:init'){
        q('#name').textContent=data.config.displayName||'Chat';
        if(data.config.welcomeText)add(data.config.welcomeText,'bot');
      }
      if(data.type==='kasitek:accepted'){
        error.textContent='';
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
        .insert_header(("Access-Control-Allow-Headers", "Content-Type"))
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
    req: HttpRequest,
    public_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized)?;
    let deployment =
        website::public_agent_website_deployment(pool.get_ref(), public_id.trim(), origin).await?;
    let normalized_origin = website::normalize_origin(origin)?;
    Ok(HttpResponse::Ok()
        .insert_header(("Access-Control-Allow-Origin", normalized_origin))
        .insert_header(("Vary", "Origin"))
        .json(serde_json::json!({
            "publicId": deployment.public_id,
            "displayName": deployment.display_name,
            "welcomeText": deployment.welcome_text,
            "launcherPosition": deployment.launcher_position,
            "colorPreset": deployment.color_preset,
            "avatarUrl": deployment.avatar_url,
            "privacyPolicyUrl": deployment.privacy_policy_url,
            "poweredBy": "KasiTek",
        })))
}

pub async fn create_agent_website_chat_session(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    public_id: web::Path<String>,
) -> Result<HttpResponse, AppError> {
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    let deployment =
        website::public_agent_website_deployment(pool.get_ref(), public_id.trim(), origin).await?;
    let session =
        website::create_agent_website_visitor_session(pool.get_ref(), &deployment, origin).await?;
    let normalized_origin = website::normalize_origin(origin)?;
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
) -> Result<HttpResponse, AppError> {
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
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
        website::active_agent_website_visitor_session(pool.get_ref(), session_id.trim(), origin)
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
            website::normalize_origin(origin)?,
        ))
        .insert_header(("Vary", "Origin"))
        .json(accepted))
}

#[cfg(test)]
mod tests {
    use super::website_channel_message_payload;

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
}

pub async fn list_agent_website_chat_deliveries(
    pool: web::Data<PgPool>,
    req: HttpRequest,
    session_id: web::Path<String>,
    query: web::Query<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, AppError> {
    let origin = req
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .ok_or(AppError::Unauthorized)?;
    let session =
        website::active_agent_website_visitor_session(pool.get_ref(), session_id.trim(), origin)
            .await?;
    let deliveries = website::list_agent_website_deliveries(
        pool.get_ref(),
        &session,
        query.get("after").map(String::as_str),
    )
    .await?;
    let normalized_origin = website::normalize_origin(origin)?;
    Ok(HttpResponse::Ok()
        .insert_header(("Access-Control-Allow-Origin", normalized_origin))
        .insert_header(("Vary", "Origin"))
        .json(serde_json::json!({ "deliveries": deliveries })))
}
