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
    const colorAlpha = color.length === 4 ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}1a` : `${color}1a`;
    const launcherSize = Number(appearance.launcherSize) || 56;
    const launcherOffset = Number(appearance.launcherOffset) || 16;
    const viewportGap = Math.max(24, launcherOffset * 2);
    const windowWidth = Number(appearance.windowWidth) || 390;
    const windowHeight = Number(appearance.windowHeight) || 620;
    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.setAttribute('aria-label', `Open ${config.displayName || 'KasiTek'} chat`);
    launcher.setAttribute('aria-expanded', 'false');
    launcher.innerHTML = '<svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8 8.7 8.7 0 0 1-3.7-.8L4 20l1.3-3.4A8 8 0 1 1 20 11.5Z"></path><path d="M8 11.5h.01M12 11.5h.01M16 11.5h.01"></path></svg>';
    launcher.style.cssText = `position:absolute;z-index:2;width:${launcherSize}px;height:${launcherSize}px;border:1px solid #ffffffb8;border-radius:50%;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;background:${color};box-shadow:0 10px 28px #11182745,0 0 0 5px ${colorAlpha};pointer-events:auto;transition:transform 160ms ease,box-shadow 160ms ease;${config.launcherPosition === 'bottom-right' ? `right:${launcherOffset}px` : `left:${launcherOffset}px`};bottom:${launcherOffset}px`;
    const overlay = document.createElement('div');
    overlay.setAttribute('data-kasitek-chat-overlay', deployment);
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
    overlay.appendChild(launcher);
    const frame = document.createElement('iframe');
    frame.src = `${api}/frame.html`;
    frame.title = `${config.displayName || 'KasiTek'} chat`;
    frame.setAttribute('aria-label', `${config.displayName || 'KasiTek'} chat`);
    frame.style.cssText = `position:absolute;z-index:1;border:0;width:${windowWidth}px;height:${windowHeight}px;max-width:calc(100vw - ${viewportGap}px);max-height:calc(100vh - ${viewportGap}px);${config.launcherPosition === 'bottom-left' ? `left:${launcherOffset}px` : `right:${launcherOffset}px`};bottom:${launcherOffset}px;display:none;background:transparent;pointer-events:auto`;
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    let ready = false;
    let expanded = false;
    const expandedSide = config.launcherPosition === 'bottom-left' ? 'left:24px;right:auto;' : 'left:auto;right:24px;';
    const setFrameLayout = () => {
      const display = frame.style.display || 'none';
      frame.style.cssText = expanded
        ? `position:absolute;z-index:1;border:0;top:12px;bottom:12px;${expandedSide}width:min(500px,calc(100vw - 48px));height:calc(100vh - 24px);max-width:none;max-height:none;display:${display};background:transparent;pointer-events:auto`
        : `position:absolute;z-index:1;border:0;width:${windowWidth}px;height:${windowHeight}px;max-width:calc(100vw - ${viewportGap}px);max-height:calc(100vh - ${viewportGap}px);${config.launcherPosition === 'bottom-left' ? `left:${launcherOffset}px` : `right:${launcherOffset}px`};bottom:${launcherOffset}px;display:${display};background:transparent;pointer-events:auto`;
    };
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
    const audioIdempotencyKey = async (audio) => {
      let fingerprint = `${audio.size}:${audio.type || 'audio/webm'}`;
      try {
        const digest = await crypto.subtle.digest('SHA-256', await audio.arrayBuffer());
        fingerprint += `:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')}`;
      } catch (_) {}
      const storageKey = `kasitek:audio:${deployment}:${session.sessionId}:${fingerprint}`;
      try {
        const existing = window.localStorage.getItem(storageKey);
        if (existing) return { key: existing, storageKey };
        const key = `audio-${crypto.randomUUID()}`;
        window.localStorage.setItem(storageKey, key);
        return { key, storageKey };
      } catch (_) {
        return { key: `audio-${crypto.randomUUID()}`, storageKey: '' };
      }
    };
    instance.open = () => { expanded = false; frame.style.display = 'block'; setFrameLayout(); launcher.style.display = 'none'; launcher.setAttribute('aria-expanded', 'true'); emit({ type: 'kasitek:open' }); };
    instance.close = () => { expanded = false; frame.style.display = 'none'; setFrameLayout(); launcher.style.display = 'flex'; launcher.setAttribute('aria-expanded', 'false'); emit({ type: 'kasitek:collapse' }); };
    launcher.addEventListener('click', instance.open);
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || event.origin !== base || !event.data) return;
      if (event.data.type === 'kasitek:ready') { ready = true; emit({ type: 'kasitek:init', config, sessionId: session.sessionId }); }
      if (event.data.type === 'kasitek:close') instance.close();
      if (event.data.type === 'kasitek:toggle-expand') { expanded = event.data.expanded === true; setFrameLayout(); }
      if (event.data.type === 'kasitek:send-audio' && event.data.audio instanceof Blob) {
        const audio = event.data.audio;
        audioIdempotencyKey(audio).then(({ key, storageKey }) => {
          const headers = { 'Content-Type': audio.type || 'audio/webm', 'X-Audio-Idempotency-Key': key };
          if (typeof event.data.fileName === 'string' && event.data.fileName.trim()) headers['X-Audio-File-Name'] = encodeURIComponent(event.data.fileName.trim().slice(0, 240));
          return fetch(`${api}/sessions/${encodeURIComponent(session.sessionId)}/audio${shareSuffix}`, { method: 'POST', credentials: 'omit', headers, body: audio })
            .then(async (r) => {
              if (!r.ok) throw new Error('Audio not accepted');
              const result = await r.json().catch(() => null);
              const jobId = typeof result?.jobId === 'string' ? result.jobId : '';
              if (!jobId) throw new Error('Audio job was not created');
              if (storageKey) window.localStorage.removeItem(storageKey);
              emit({ type: 'kasitek:accepted', jobId, status: result.status || 'queued' });
              pollAudioStatus(jobId);
            });
        })
          .catch(() => emit({ type: 'kasitek:error', message: 'Unable to process your audio. Please try again.' }));
      }
      if (event.data.type === 'kasitek:retry-audio' && typeof event.data.jobId === 'string') retryAudio(event.data.jobId);
      if (event.data.type === 'kasitek:send' && typeof event.data.text === 'string') {
        fetch(`${api}/sessions/${encodeURIComponent(session.sessionId)}/messages${shareSuffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), text: event.data.text }) })
          .then(async (r) => {
            const result = await r.json().catch(() => null);
            if (!r.ok) throw new Error('Message not accepted');
            if (result?.status === 'handoff_requested' || result?.handoffRequestId) {
              emit({ type: 'kasitek:handoff-requested', text: 'Your request has been sent to a team member. Someone will respond here.' });
            } else {
              emit({ type: 'kasitek:accepted', status: result?.status || '' });
            }
          })
          .catch(() => emit({ type: 'kasitek:error', message: 'Unable to send your message. Please try again.' }));
      }
    });
    let after = '';
    setInterval(() => fetch(`${api}/sessions/${encodeURIComponent(session.sessionId)}/deliveries${share ? `?share=1${after ? `&after=${encodeURIComponent(after)}` : ''}` : after ? `?after=${encodeURIComponent(after)}` : ''}`, { credentials: 'omit' })
      .then((r) => r.ok ? r.json() : null).then((result) => result?.deliveries?.forEach((delivery) => { after = delivery.id; emit({ type: 'kasitek:reply', text: delivery.messageText, content: delivery.messageContent }); })).catch(() => {}), 1500);
  }).catch((error) => console.warn('[KasiTek Chat]', error.message));
})();"#;

const WEBSITE_CHAT_FRAME: &str = r#"<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{box-sizing:border-box}
    :root{color-scheme:light;--chat-primary:#3730a3;--chat-ink:#1f1f1f;--chat-muted:#8b8b8b}
    html,body{width:100%;height:100%;overflow:hidden}
    body{margin:0;background:transparent;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--chat-ink);font-size:14px}
    #chat{height:100%;min-height:0;display:flex;flex-direction:column;background:#fff;border:1px solid #d9d9d9;border-radius:var(--chat-radius,18px);box-shadow:0 20px 55px #1118272e;overflow:hidden}
    header{min-height:72px;padding:14px 15px;background:#1f1f1f;color:#fff;display:flex;align-items:center;justify-content:space-between;gap:12px;flex:0 0 auto}
    button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
    button:focus-visible,input:focus-visible{outline:2px solid var(--chat-primary);outline-offset:2px}
    button:disabled,input:disabled{cursor:not-allowed;opacity:.6}
    .header-content{display:flex;align-items:center;min-width:0;gap:11px}
    .avatar{position:relative;width:40px;height:40px;display:grid;place-items:center;flex:0 0 auto;border:2px solid #fff;border-radius:50%;background:#f4f4f2;color:#1f1f1f;overflow:visible}
    .avatar:after{content:"";position:absolute;right:-2px;bottom:-1px;width:9px;height:9px;border:2px solid #1f1f1f;border-radius:50%;background:var(--chat-primary)}
    .avatar svg{width:27px;height:27px}
    .avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover}
    .header-copy{display:flex;min-width:0;flex-direction:column;gap:2px}
    #name{max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:700;line-height:1.2}
    .eyebrow{color:#bdbdbd;font-size:11px;font-weight:500;line-height:1.2}
    .header-actions{display:flex;align-items:center;gap:2px;flex:0 0 auto}
    .header-action{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;color:#d1d1d1;transition:background 140ms ease,color 140ms ease}
    .header-action:hover{background:#ffffff14;color:#fff}
    .header-action svg{width:19px;height:19px}
    #back[hidden]{display:none}
    #messages{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:16px 15px;background:#fff;display:flex;flex-direction:column;gap:10px;scrollbar-color:#d5d5d5 transparent;scrollbar-width:thin}
    .m{max-width:88%;padding:10px 13px;border-radius:16px;overflow-wrap:anywhere;word-break:break-word;line-height:1.42;font-size:13.5px}
    .me{align-self:flex-end;background:var(--chat-primary);color:#fff;border-radius:16px 5px 16px 16px;box-shadow:0 4px 12px #1118271c}
    .bot{align-self:flex-start;max-width:92%;background:#f3f1f0;color:#292929;border-radius:5px 16px 16px 16px}
    .quick-replies{display:flex;align-self:flex-start;flex-wrap:wrap;gap:6px;max-width:100%;padding:0 1px 2px}
    .quick-replies[hidden]{display:none}
    .quick-replies button{padding:7px 10px;border:1px solid #d0d0d0;border-radius:999px;background:#fff;color:#3a3a3a;font-size:12px;line-height:1.2;transition:background 140ms ease,border-color 140ms ease}
    .quick-replies button:hover{border-color:#969696;background:#f6f6f6}
    .line{min-height:1.35em}
    .line.bullet{padding-left:4px}
    .bot strong{font-weight:700;color:#111827}
    .bot code{padding:1px 4px;border-radius:4px;background:#d7dce8;font-size:.9em}
    .media-preview{display:block;max-width:100%;max-height:320px;margin:8px 0;border-radius:8px;object-fit:contain;background:#d7dce8}
    .media-link{display:block;margin:8px 0;color:#1d4ed8;font-weight:600;overflow-wrap:anywhere}
    .media-caption{margin-top:5px;font-size:12px;opacity:.8}
    .transcript{margin-top:7px;padding-top:7px;border-top:1px solid #ffffff55;font-size:12px;line-height:1.35;opacity:.9}
    .transcript button{margin-left:7px;padding:2px 7px;border:1px solid #ffffff88;border-radius:6px;font-size:11px}
    .audio-player{display:block;width:min(100%,260px);height:32px;margin-bottom:7px}
    .bot table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}
    .bot th,.bot td{padding:7px 8px;border:1px solid #cbd5e1;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
    .bot th{background:#dce2ee;font-weight:700}
    .ui-stack{display:flex;flex-direction:column;gap:8px;margin-top:10px}
    .ui-card{padding:10px;border:1px solid #dedede;border-radius:12px;background:#fff;box-shadow:0 2px 8px #1118270b}
    .ui-title{margin:0 0 8px;color:#171717;font-size:12px;font-weight:700;line-height:1.3}
    .ui-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
    .ui-summary-item{min-width:0;padding:7px 8px;border:1px solid #e7e7e7;border-radius:8px;background:#fafafa}
    .ui-summary-label{display:block;overflow:hidden;color:#777;font-size:10px;text-overflow:ellipsis;white-space:nowrap}
    .ui-summary-value{display:flex;align-items:center;gap:5px;margin-top:3px;overflow:hidden;color:#222;font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
    .ui-list{display:flex;flex-direction:column;overflow:hidden;border:1px solid #e7e7e7;border-radius:9px;background:#fafafa}
    .ui-row{display:flex;min-width:0;align-items:center;gap:7px;padding:8px;border-bottom:1px solid #e7e7e7}
    .ui-row:last-child{border-bottom:0}
    .ui-row-copy{min-width:0;flex:1}
    .ui-row-title{overflow:hidden;color:#222;font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
    .ui-row-description{margin-top:2px;overflow:hidden;color:#777;font-size:10px;text-overflow:ellipsis;white-space:nowrap}
    .ui-row-meta{flex:0 0 auto;max-width:42%;overflow:hidden;color:#777;font-size:10px;text-overflow:ellipsis;white-space:nowrap}
    .ui-empty{padding:9px;border:1px dashed #d7d7d7;border-radius:9px;color:#777;font-size:11px}
    .ui-dot{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:#9ca3af}
    .ui-dot.success{background:#16a34a}.ui-dot.warning{background:#d97706}.ui-dot.danger{background:#dc2626}
    .ui-progress{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
    .ui-progress-item{display:flex;align-items:flex-start;gap:7px;color:#222;font-size:12px}
    .ui-progress-icon{width:7px;height:7px;flex:0 0 auto;margin-top:4px;border:1.5px solid #9ca3af;border-radius:50%}
    .ui-progress-icon.complete{border-color:#16a34a;background:#16a34a}.ui-progress-icon.active{border-color:var(--chat-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--chat-primary) 14%,transparent)}.ui-progress-icon.error{border-color:#dc2626;background:#dc2626}
    .ui-progress-detail{display:block;margin-top:2px;color:#777;font-size:10px}
    .ui-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
    .ui-action{padding:6px 9px;border:1px solid #cfcfcf;border-radius:8px;background:#fff;color:var(--chat-primary);font-size:11px;font-weight:600;line-height:1.2;text-decoration:none;transition:background 140ms ease,border-color 140ms ease}
    .ui-action:hover{border-color:var(--chat-primary);background:#f6f5ff}
    .ui-workspace{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid color-mix(in srgb,var(--chat-primary) 22%,#dedede);border-radius:10px;background:color-mix(in srgb,var(--chat-primary) 4%,#fff)}
    .ui-workspace-copy{min-width:0;flex:1}.ui-workspace-title{color:#222;font-size:12px;font-weight:700}.ui-workspace-description{margin-top:3px;color:#777;font-size:10px;line-height:1.35}.ui-workspace-link{flex:0 0 auto;color:var(--chat-primary);font-size:11px;font-weight:700;text-decoration:none}.ui-workspace-link:hover{text-decoration:underline}
    .ui-form{display:flex;flex-direction:column;gap:9px}.ui-field{display:flex;flex-direction:column;gap:4px}.ui-field-label{color:#333;font-size:11px;font-weight:600}.ui-field-description{color:#777;font-size:10px;line-height:1.3}.ui-field input,.ui-field textarea,.ui-field select{width:100%;min-height:32px;padding:7px 8px;border:1px solid #d4d4d4;border-radius:7px;background:#fff;color:#222;font:inherit;font-size:12px;outline:0}.ui-field textarea{min-height:66px;resize:vertical}.ui-field input:focus,.ui-field textarea:focus,.ui-field select:focus{border-color:var(--chat-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--chat-primary) 13%,transparent)}.ui-checkbox{display:flex;align-items:flex-start;gap:7px;color:#333;font-size:11px}.ui-checkbox input{width:15px;height:15px;min-height:15px;margin:0;accent-color:var(--chat-primary)}.ui-field-error{color:#b91c1c;font-size:10px}.ui-form button:disabled{cursor:wait;opacity:.65}
    .ui-choice-list{display:flex;flex-direction:column;gap:6px}.ui-choice{display:flex;align-items:flex-start;gap:8px;width:100%;padding:8px 9px;border:1px solid #d7d7d7;border-radius:9px;background:#fff;color:#222;text-align:left;font:inherit;font-size:12px;cursor:pointer;transition:background 140ms ease,border-color 140ms ease}.ui-choice:hover{border-color:var(--chat-primary);background:#f6f5ff}.ui-choice-index{display:grid;place-items:center;width:19px;height:19px;flex:0 0 auto;border-radius:50%;background:color-mix(in srgb,var(--chat-primary) 11%,#fff);color:var(--chat-primary);font-size:10px;font-weight:700}.ui-choice-copy{min-width:0}.ui-choice-title{font-weight:600}.ui-choice-description{margin-top:2px;color:#777;font-size:10px;line-height:1.3}
    form{display:flex;padding:10px 12px 9px;border-top:1px solid #eeeeee;background:#fff;flex:0 0 auto}
    .composer{display:flex;align-items:center;gap:2px;width:100%;min-height:46px;padding:4px 5px 4px 11px;border:1px solid #bdbdbd;border-radius:24px;background:#fff;transition:border-color 140ms ease,box-shadow 140ms ease}
    .composer:focus-within{border-color:#777;box-shadow:0 0 0 3px color-mix(in srgb,var(--chat-primary) 13%,transparent)}
    input{min-width:0;flex:1;border:0;outline:0;padding:8px 6px;background:transparent;color:#242424;font:inherit;font-size:13.5px}
    input::placeholder{color:#848484;opacity:1}
    .composer-button{display:grid;place-items:center;width:34px;height:34px;flex:0 0 auto;border-radius:50%;color:#8b8b8b;transition:background 140ms ease,color 140ms ease}
    .composer-button:hover{background:#f2f2f2;color:#3a3a3a}
    .composer-button svg{width:18px;height:18px}
    #audio-button.recording{color:#b91c1c;background:#fee2e2}
    #send-button{background:var(--chat-primary);color:#fff}
    #send-button:hover{background:color-mix(in srgb,var(--chat-primary) 86%,#000)}
    #send-button:disabled{background:#d7d7d7;color:#fff}
    #file-input{display:none}
    small{display:block;padding:0 12px 11px;color:#8c8c8c;text-align:center;font-size:11px;line-height:1.35;flex:0 0 auto}
    small[hidden]{display:none!important}
    small a{color:inherit;text-decoration:none}
    small a:hover{text-decoration:underline}
    #powered-by{white-space:nowrap}
    #powered-by[hidden]{display:none}
    #powered-by a{color:var(--chat-primary);font-weight:600;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
    #powered-by a:hover{opacity:.78}
    #error{color:#b91c1c;padding:0 14px 8px;font-size:12px;line-height:1.35;flex:0 0 auto}
    #error:empty{display:none}
    .typing{display:flex;align-items:center;gap:4px;color:#777}
    .typing[hidden]{display:none!important}
    .typing span{margin-right:2px}
    .typing i{width:5px;height:5px;border-radius:50%;background:#777;animation:typing-dot 1s infinite ease-in-out}
    .typing i:nth-child(2){animation-delay:.15s}
    .typing i:nth-child(3){animation-delay:.3s}
    .typing i:nth-child(4){animation-delay:.45s}
    @keyframes typing-dot{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
    @media (max-width:480px){header{min-height:66px;padding:12px}.avatar{width:36px;height:36px}.avatar svg{width:24px;height:24px}.header-action{width:32px;height:32px}#messages{padding:14px 12px}form{padding-left:10px;padding-right:10px}}
    @media (prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.01ms!important}}
  </style>
</head>
<body>
  <div id="chat">
    <header>
      <div class="header-content">
        <button id="back" class="header-action" type="button" aria-label="Restore chat size" title="Restore chat size" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg></button>
        <div id="avatar" class="avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="7" width="14" height="11" rx="3"></rect><path d="M9 7V5h6v2M8 12h.01M16 12h.01M9 15h6"></path></svg></div>
        <div class="header-copy"><strong id="name">Chat</strong><span class="eyebrow">Powered by AI</span></div>
      </div>
      <div class="header-actions">
        <button id="expand" class="header-action" type="button" aria-label="Expand chat" title="Expand chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5M3 3l7 7M16 21h5v-5M21 21l-7-7"></path></svg></button>
        <button id="close" class="header-action" type="button" aria-label="Close chat" title="Close chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg></button>
      </div>
    </header>
    <main id="messages"><div id="quick-replies" class="quick-replies" hidden></div><div id="typing" class="m bot typing" hidden aria-live="polite"><span>Thinking</span><i></i><i></i><i></i></div></main>
    <div id="error" role="alert"></div>
    <form id="form"><div class="composer"><button id="audio-button" class="composer-button" type="button" aria-label="Record audio" title="Record audio"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"></path></svg></button><input id="input" maxlength="4000" placeholder="Ask me anything..." aria-label="Message"><button id="file-button" class="composer-button" type="button" aria-label="Attach audio" title="Attach audio"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20.5 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.4-8.4a3.5 3.5 0 0 1 5 5l-8.4 8.4a2 2 0 1 1-2.8-2.8l7.8-7.8"></path></svg></button><button id="send-button" class="composer-button" type="submit" aria-label="Send message" title="Send message"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 14-7-4 14-3-6-7-1Z"></path><path d="m12 13 7-8"></path></svg></button><input id="file-input" type="file" accept="audio/*"></div></form>
    <small id="branding"><span>AI-generated content may be inaccurate.</span><span id="powered-by"> · Powered by <a href="https://kasitek.co.za" target="_blank" rel="noopener noreferrer">KasiTek</a></span></small>
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
    const quickReplies=q('#quick-replies');
    const error=q('#error');
    const expandButton=q('#expand');
    const backButton=q('#back');
    const parentOrigin=(()=>{try{return new URL(document.referrer).origin}catch{return ''}})();
    const targetOrigin=parentOrigin||'*';
    const avatarFallback=q('#avatar').innerHTML;
    const audioIcon=audioButton.innerHTML;
    const stopIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>';
    const expandIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H3v5M3 3l7 7M16 21h5v-5M21 21l-7-7"></path></svg>';
    const restoreIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3H3v6M3 3l7 7M15 21h6v-6M21 21l-7-7"></path></svg>';
    let pending=false;
    let handoffPending=false;
    let pendingTimer=null;
    let recorder=null;
    let stream=null;
    let recordedChunks=[];
    let pendingAudioMessage=null;
    let expanded=false;

    const setSendState=(isSending)=>{
      sendButton.setAttribute('aria-label',isSending?'Sending message':'Send message');
      sendButton.title=isSending?'Sending message':'Send message';
    };
    const setComposerState=()=>{
      const disabled=pending||handoffPending;
      input.disabled=disabled;
      sendButton.disabled=disabled;
      audioButton.disabled=disabled;
      fileButton.disabled=disabled;
      input.placeholder=handoffPending?'Waiting for a reply...':'Ask me anything...';
    };
    const setExpandState=()=>{
      expandButton.innerHTML=expanded?restoreIcon:expandIcon;
      expandButton.setAttribute('aria-label',expanded?'Restore chat size':'Expand chat');
      expandButton.title=expanded?'Restore chat size':'Expand chat';
      expandButton.setAttribute('aria-expanded',String(expanded));
      backButton.hidden=!expanded;
    };
    const renderQuickReplies=()=>{
      ['What can you help with?','How does this work?','Talk to a person'].forEach((label)=>{
        const button=document.createElement('button');
        button.type='button';
        button.textContent=label;
        button.addEventListener('click',()=>sendText(label));
        quickReplies.append(button);
      });
      quickReplies.hidden=false;
      messages.append(quickReplies);
    };
    const hideQuickReplies=()=>{quickReplies.hidden=true};

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
    const appendMedia=(parent,content)=>{
      const media=Array.isArray(content?.media)?content.media:[];
      media.forEach((item)=>{
        if(typeof item?.previewUrl!=='string'||!item.previewUrl)return;
        const label=String(item.altText||item.fileName||item.caption||'Attachment');
        let element;
        if(item.kind==='image'){
          element=document.createElement('img');element.className='media-preview';element.src=item.previewUrl;element.alt=label;element.loading='lazy';
        }else if(item.kind==='video'){
          element=document.createElement('video');element.className='media-preview';element.src=item.previewUrl;element.controls=true;element.preload='metadata';
        }else if(item.kind==='audio'){
          element=document.createElement('audio');element.className='media-preview';element.src=item.previewUrl;element.controls=true;element.preload='metadata';
        }else{
          element=document.createElement('a');element.className='media-link';element.href=item.previewUrl;element.target='_blank';element.rel='noopener noreferrer';element.textContent=`Download ${label}`;
        }
        parent.append(element);
        if(item.caption){const caption=document.createElement('div');caption.className='media-caption';appendInline(caption,item.caption);parent.append(caption)}
      });
    };
    const uiText=(value,max)=>typeof value==='string'&&value.trim()?value.trim().slice(0,max):'';
    const uiTone=(value)=>['success','warning','danger','neutral'].includes(value)?value:'neutral';
    const appendInternalLink=(parent,label,href)=>{
      if(typeof href!=='string'||!href.startsWith('/')||href.startsWith('//'))return false;
      const link=document.createElement('a');link.className='ui-action';link.href=href;link.target='_top';link.textContent=label;parent.append(link);return true;
    };
    const appendUiAction=(parent,action)=>{
      const label=uiText(action?.label,80);
      if(!label)return;
      if(action?.kind==='navigate'&&appendInternalLink(parent,label,action.href))return;
      const prompt=uiText(action?.prompt,500);
      if(action?.kind==='follow_up'&&prompt){
        const button=document.createElement('button');button.type='button';button.className='ui-action';button.textContent=label;button.addEventListener('click',()=>sendText(prompt));parent.append(button);
      }
      if(action?.kind==='refresh'||action?.kind==='resume'){
        const button=document.createElement('button');button.type='button';button.className='ui-action';button.textContent=label;button.addEventListener('click',()=>sendText(action.kind==='refresh'?'Refresh the information shown above.':'Continue with the waiting task.'));parent.append(button);
      }
    };
    const appendWorkspace=(card,block)=>{
      const workspace=document.createElement('div');workspace.className='ui-workspace';
      const copy=document.createElement('div');copy.className='ui-workspace-copy';
      const title=document.createElement('div');title.className='ui-workspace-title';title.textContent=uiText(block.title,500);copy.append(title);
      const description=uiText(block.description,320);if(description){const detail=document.createElement('div');detail.className='ui-workspace-description';detail.textContent=description;copy.append(detail)}
      workspace.append(copy);
      const linkLabel='Open';
      if(!appendInternalLink(workspace,linkLabel,block.href)){return}
      const link=workspace.lastElementChild;if(link)link.className='ui-workspace-link';
      card.append(workspace);
      if(Array.isArray(block.actions)&&block.actions.length){const actions=document.createElement('div');actions.className='ui-actions';block.actions.filter((action)=>!(action?.kind==='navigate'&&action.href===block.href)).slice(0,2).forEach((action)=>appendUiAction(actions,action));if(actions.children.length)card.append(actions)}
    };
    const appendForm=(card,block)=>{
      const form=document.createElement('div');form.className='ui-form';
      const controls=[];
      (Array.isArray(block.fields)?block.fields:[]).slice(0,8).forEach((field)=>{
        const wrapper=document.createElement('label');wrapper.className='ui-field';
        const label=document.createElement('span');label.className='ui-field-label';label.textContent=uiText(field.label,500)+(field.required?' *':'');wrapper.append(label);
        if(field.description){const description=document.createElement('span');description.className='ui-field-description';description.textContent=uiText(field.description,240);wrapper.append(description)}
        let control;
        if(field.type==='select'){
          control=document.createElement('select');
          const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Select an option';control.append(placeholder);
          (Array.isArray(field.options)?field.options:[]).slice(0,20).forEach((option)=>{const item=document.createElement('option');item.value=uiText(option.id,80);item.textContent=uiText(option.label,500);control.append(item)});
        }else if(field.type==='checkbox'){
          wrapper.className='ui-checkbox';control=document.createElement('input');control.type='checkbox';wrapper.replaceChildren(control,label);if(field.description){const description=document.createElement('span');description.className='ui-field-description';description.textContent=uiText(field.description,240);wrapper.append(description)}
        }else{
          control=document.createElement(field.type==='textarea'?'textarea':'input');if(field.type!=='textarea')control.type='text';if(field.placeholder)control.placeholder=uiText(field.placeholder,160);if(Number.isFinite(Number(field.maxLength)))control.maxLength=Number(field.maxLength);
          wrapper.append(control);
        }
        control.dataset.fieldId=uiText(field.id,80);control.dataset.fieldType=field.type;control.dataset.fieldLabel=uiText(field.label,500);control.dataset.required=field.required?'true':'false';controls.push(control);form.append(wrapper);
      });
      const actions=document.createElement('div');actions.className='ui-actions';
      const submit=document.createElement('button');submit.type='button';submit.className='ui-action';submit.textContent='Submit';
      submit.addEventListener('click',()=>{
        const values=[];let invalid=false;
        controls.forEach((control)=>{
          const wrapper=control.parentElement;wrapper?.querySelector('.ui-field-error')?.remove();
          const value=control.type==='checkbox'?String(control.checked):(control.value||'').trim();
          if(control.dataset.required==='true'&&(!value||control.type==='checkbox'&&value!=='true')){const message=document.createElement('span');message.className='ui-field-error';message.textContent='Required';wrapper?.append(message);invalid=true;return}
          if(value&&control.dataset.fieldLabel)values.push(`${control.dataset.fieldLabel}: ${value==='true'?'Yes':value}`);
        });
        if(invalid)return;
        if(!values.length){const message=document.createElement('span');message.className='ui-field-error';message.textContent='Complete at least one field';form.append(message);return}
        submit.disabled=true;submit.textContent='Submitting…';sendText(`${uiText(block.title,120)||'Form'}\n${values.join('\n')}`);
      });
      actions.append(submit);form.append(actions);card.append(form);
    };
    const appendChoice=(card,block)=>{
      const list=document.createElement('div');list.className='ui-choice-list';
      (Array.isArray(block.options)?block.options:[]).slice(0,8).forEach((option,index)=>{
        const button=document.createElement('button');button.type='button';button.className='ui-choice';
        const number=document.createElement('span');number.className='ui-choice-index';number.textContent=String(index+1);button.append(number);
        const copy=document.createElement('span');copy.className='ui-choice-copy';const title=document.createElement('span');title.className='ui-choice-title';title.textContent=uiText(option.label,500);copy.append(title);if(option.description){const description=document.createElement('span');description.className='ui-choice-description';description.textContent=uiText(option.description,240);copy.append(description)}button.append(copy);
        button.addEventListener('click',()=>sendText(uiText(option.label,240)));list.append(button);
      });
      card.append(list);
    };
    const appendUi=(parent,ui)=>{
      if(!ui||ui.version!=='1'||!Array.isArray(ui.blocks))return;
      const stack=document.createElement('div');stack.className='ui-stack';
      ui.blocks.slice(0,4).forEach((block)=>{
        if(!block||!['summary','list','progress','workspace','form','choice'].includes(block.type))return;
        const card=document.createElement('section');card.className='ui-card';card.setAttribute('aria-label',uiText(block.title,120)||'Interactive result');
        const title=uiText(block.title,500);
        if(title){const heading=document.createElement('h3');heading.className='ui-title';heading.textContent=title;card.append(heading)}
        if(block.type==='summary'&&Array.isArray(block.items)){
          const summary=document.createElement('div');summary.className='ui-summary';
          block.items.slice(0,8).forEach((item)=>{
            const label=uiText(item?.label,500);const value=uiText(item?.value,240);if(!label||!value)return;
            const cell=document.createElement('div');cell.className='ui-summary-item';
            const labelElement=document.createElement('span');labelElement.className='ui-summary-label';labelElement.textContent=label;cell.append(labelElement);
            const valueElement=document.createElement('span');valueElement.className='ui-summary-value';
            if(item.status){const dot=document.createElement('span');dot.className=`ui-dot ${uiTone(item.status)}`;dot.setAttribute('aria-hidden','true');valueElement.append(dot)}
            valueElement.append(document.createTextNode(value));cell.append(valueElement);summary.append(cell);
          });
          card.append(summary);
        }
        if(block.type==='list'){
          if(Array.isArray(block.items)&&block.items.length){
            const list=document.createElement('div');list.className='ui-list';
            block.items.slice(0,24).forEach((item)=>{
              const itemTitle=uiText(item?.title,500);if(!itemTitle)return;
              const row=document.createElement('div');row.className='ui-row';
              if(item.status){const dot=document.createElement('span');dot.className=`ui-dot ${uiTone(item.status)}`;dot.setAttribute('aria-hidden','true');row.append(dot)}
              const copy=document.createElement('div');copy.className='ui-row-copy';const heading=document.createElement('div');heading.className='ui-row-title';heading.textContent=itemTitle;copy.append(heading);
              const description=uiText(item?.description,320);if(description){const detail=document.createElement('div');detail.className='ui-row-description';detail.textContent=description;copy.append(detail)}
              row.append(copy);const meta=uiText(item?.meta,240);if(meta){const metaElement=document.createElement('span');metaElement.className='ui-row-meta';metaElement.textContent=meta;row.append(metaElement)}list.append(row);
            });
            card.append(list);
          }else{const empty=document.createElement('div');empty.className='ui-empty';empty.textContent=uiText(block.emptyText,160)||'Nothing to show';card.append(empty)}
          if(Array.isArray(block.actions)&&block.actions.length){const actions=document.createElement('div');actions.className='ui-actions';block.actions.slice(0,2).forEach((action)=>appendUiAction(actions,action));if(actions.children.length)card.append(actions)}
        }
        if(block.type==='progress'&&Array.isArray(block.steps)){
          const progress=document.createElement('ol');progress.className='ui-progress';
          block.steps.slice(0,12).forEach((step)=>{
            const label=uiText(step?.label,500);if(!label)return;
            const row=document.createElement('li');row.className='ui-progress-item';const icon=document.createElement('span');icon.className=`ui-progress-icon ${step.status==='complete'?'complete':step.status==='active'?'active':step.status==='error'?'error':''}`;icon.setAttribute('aria-hidden','true');row.append(icon);const copy=document.createElement('span');copy.textContent=label;const detail=uiText(step?.detail,240);if(detail){const detailElement=document.createElement('span');detailElement.className='ui-progress-detail';detailElement.textContent=detail;copy.append(detailElement)}row.append(copy);progress.append(row);
          });
          card.append(progress);
        }
        if(block.type==='workspace')appendWorkspace(card,block);
        if(block.type==='form')appendForm(card,block);
        if(block.type==='choice')appendChoice(card,block);
        if(card.children.length)stack.append(card);
      });
      if(stack.children.length)parent.append(stack);
    };
    const add=(text,kind,content)=>{
      const element=document.createElement('div');
      element.className='m '+kind;
      if(kind==='bot')appendFormatted(element,text);else appendInline(element,text);
      if(kind==='bot'){appendUi(element,content?.ui);appendMedia(element,content)}
      messages.append(element);
      scrollToBottom();
      return element;
    };
    const stopPending=()=>{
      pending=false;
      typing.hidden=true;
      setComposerState();
      setSendState(false);
      if(pendingTimer){window.clearTimeout(pendingTimer);pendingTimer=null}
    };
    const startPending=()=>{
      pending=true;
      typing.hidden=false;
      messages.append(typing);
      setComposerState();
      setSendState(true);
      scrollToBottom();
      if(pendingTimer)window.clearTimeout(pendingTimer);
      pendingTimer=window.setTimeout(()=>{
        if(!pending)return;
        stopPending();
        error.textContent='The agent is taking longer than expected. Please try again.';
        scrollToBottom();
      },45000);
    };
    const showHandoffPending=(text)=>{
      stopPending();
      handoffPending=true;
      setComposerState();
      add(text,'bot');
    };
    const sendAudio=(audio,fileName)=>{
      if(pending||handoffPending)return;
      error.textContent='';
      hideQuickReplies();
      pendingAudioMessage=add('Audio message','me');
      startPending();
      parent.postMessage({type:'kasitek:send-audio',audio,fileName},targetOrigin);
    };
    const stopTracks=()=>{if(stream){stream.getTracks().forEach((track)=>track.stop());stream=null}recorder=null;audioButton.classList.remove('recording');audioButton.innerHTML=audioIcon;audioButton.setAttribute('aria-label','Record audio');audioButton.title='Record audio'};
    const supportedRecordingType=()=>{if(typeof MediaRecorder==='undefined')return '';return ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg'].find((value)=>MediaRecorder.isTypeSupported(value))||''};
    audioButton.onclick=async()=>{
      if(pending||handoffPending)return;
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
        audioButton.classList.add('recording');audioButton.innerHTML=stopIcon;audioButton.setAttribute('aria-label','Stop recording');audioButton.title='Stop recording';
      }catch(errorValue){stopTracks();error.textContent=errorValue?.name==='NotAllowedError'?'Microphone permission is required':'Unable to access the microphone'}
    };
    fileButton.onclick=()=>{if(!pending&&!handoffPending)fileInput.click()};
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
        q('#powered-by').hidden=appearance.showBranding===false;
        if(typeof data.config.avatarUrl==='string'&&data.config.avatarUrl){const image=document.createElement('img');image.src=data.config.avatarUrl;image.alt='';image.onload=()=>{q('#avatar').replaceChildren(image)};image.onerror=()=>{q('#avatar').innerHTML=avatarFallback}};
        if(data.config.welcomeText)add(data.config.welcomeText,'bot');
        renderQuickReplies();
      }
      if(data.type==='kasitek:collapse'){expanded=false;setExpandState()}
      if(data.type==='kasitek:accepted'){
        error.textContent='';
        if(pendingAudioMessage){const transcript=pendingAudioMessage.querySelector('.transcript');if(transcript)transcript.textContent='Transcribing…';else{const next=document.createElement('div');next.className='transcript';next.textContent='Transcribing…';pendingAudioMessage.append(next)}}
      }
      if(data.type==='kasitek:handoff-requested'){
        error.textContent='';
        showHandoffPending(data.text||'Your request has been sent to a team member. Someone will respond here.');
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
        handoffPending=false;
        stopPending();
        add(data.text,'bot',data.content);
      }
      if(data.type==='kasitek:error'){
        stopPending();
        error.textContent=data.message||'Something went wrong';
        scrollToBottom();
      }
    });
    expandButton.onclick=()=>{expanded=!expanded;setExpandState();parent.postMessage({type:'kasitek:toggle-expand',expanded},targetOrigin)};
    backButton.onclick=()=>{expanded=false;setExpandState();parent.postMessage({type:'kasitek:toggle-expand',expanded},targetOrigin)};
    q('#close').onclick=()=>parent.postMessage({type:'kasitek:close'},targetOrigin);
    const sendText=(value)=>{
      if(pending||handoffPending)return;
      const text=String(value||'').trim();
      if(!text)return;
      error.textContent='';
      hideQuickReplies();
      add(text,'me');
      startPending();
      parent.postMessage({type:'kasitek:send',text},targetOrigin);
    };
    q('#form').onsubmit=(event)=>{
      event.preventDefault();
      const value=input.value;
      input.value='';
      sendText(value);
    };
    setExpandState();
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
        .map(str::to_string)
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
    .bind(&asset_id)
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
            Value::String(content_media::public_media_url(config.get_ref(), &asset_id)),
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
    use super::{
        website_channel_audio_payload, website_channel_message_payload, WEBSITE_CHAT_FRAME,
        WEBSITE_CHAT_LOADER,
    };

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

    #[test]
    fn widget_frame_keeps_the_polished_shell_and_existing_controls() {
        assert!(WEBSITE_CHAT_FRAME.contains("Powered by AI"));
        assert!(WEBSITE_CHAT_FRAME.contains("Ask me anything..."));
        assert!(WEBSITE_CHAT_FRAME.contains("kasitek:handoff-requested"));
        assert!(WEBSITE_CHAT_FRAME.contains("showHandoffPending"));
        assert!(WEBSITE_CHAT_FRAME.contains("Your request has been sent to a team member"));
        assert!(WEBSITE_CHAT_FRAME.contains("AI-generated content may be inaccurate."));
        assert!(WEBSITE_CHAT_FRAME.contains("#powered-by a{color:var(--chat-primary)"));
        assert!(WEBSITE_CHAT_FRAME.contains("quick-replies"));
        assert!(WEBSITE_CHAT_FRAME.contains("appendUi"));
        assert!(WEBSITE_CHAT_FRAME.contains("ui-card"));
        assert!(WEBSITE_CHAT_FRAME.contains("ui-workspace"));
        assert!(WEBSITE_CHAT_FRAME.contains("ui-form"));
        assert!(WEBSITE_CHAT_FRAME.contains("ui-choice"));
        assert!(WEBSITE_CHAT_FRAME.contains("id=\"audio-button\""));
        assert!(WEBSITE_CHAT_FRAME.contains("id=\"file-button\""));
        assert!(WEBSITE_CHAT_FRAME.contains("id=\"send-button\""));
        assert!(WEBSITE_CHAT_FRAME.contains("id=\"back\""));
    }

    #[test]
    fn widget_loader_supports_expanding_and_restoring_the_frame() {
        assert!(WEBSITE_CHAT_LOADER.contains("kasitek:toggle-expand"));
        assert!(WEBSITE_CHAT_LOADER.contains("kasitek:handoff-requested"));
        assert!(WEBSITE_CHAT_LOADER.contains("handoffRequestId"));
        assert!(WEBSITE_CHAT_LOADER.contains("width:min(500px,calc(100vw - 48px))"));
        assert!(WEBSITE_CHAT_LOADER.contains("top:12px;bottom:12px"));
        assert!(WEBSITE_CHAT_LOADER.contains("aria-expanded"));
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
    let organization_id =
        website::agent_website_deployment_org_id(pool.get_ref(), &session.deployment_id).await?;
    let mut deliveries = deliveries;
    website::add_agent_website_delivery_previews(
        pool.get_ref(),
        config.get_ref(),
        &organization_id,
        &mut deliveries,
    )
    .await?;
    let normalized_origin = website::normalize_origin(&origin)?;
    Ok(HttpResponse::Ok()
        .insert_header(("Access-Control-Allow-Origin", normalized_origin))
        .insert_header(("Vary", "Origin"))
        .json(serde_json::json!({ "deliveries": deliveries })))
}
