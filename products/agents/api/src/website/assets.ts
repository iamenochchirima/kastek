export { WEBSITE_WIDGET_FRAME } from './frame';

// Visitor capabilities are scoped to one website origin and session. No admin cookie or provider key.
export const WEBSITE_WIDGET_LOADER = String.raw`
(() => {
  const script = document.currentScript;
  const deployment = script && script.dataset.kasitekDeployment;
  if (!deployment || window.KasiTekChat?.instances?.[deployment]) return;
  const base = new URL(script.src).origin;
  const api = base + '/api/widget/v1';
  const storageKey = 'kasitek:visitor:' + base + ':' + deployment;
  let session, frame, ready = false, config, seen = new Set(), polling = false, lastStatus = '', cursor = '0', pollTimer;
  const instance = { open: () => {}, close: () => {} };
  window.KasiTekChat = window.KasiTekChat || { instances: {} };
  window.KasiTekChat.instances[deployment] = instance;
  const emit = payload => { if (ready) frame.contentWindow.postMessage(payload, base); };
  async function call(path, body, authenticated = true) {
    const headers = { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authenticated ? { Authorization: 'Bearer ' + session.token } : {}) };
    const response = await fetch(api + path, { method: body === undefined ? 'GET' : 'POST', headers,
      credentials: 'omit', signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Website chat unavailable');
    return result;
  }
  async function history() { return call('/sessions/' + session.sessionId + '/conversation'); }
  function receive(result) {
    for (const message of result.messages || []) {
      if (!seen.has(message.id) && message.direction === 'outbound') emit({ type: 'kasitek:reply', text: message.text });
      seen.add(message.id);
      if (BigInt(message.sequence) > BigInt(cursor)) cursor = message.sequence;
    }
    const status = result.run?.status || '';
    if (status !== lastStatus && ['failed', 'cancelled', 'expired'].includes(status)) emit({ type: 'kasitek:error', message: 'The agent could not finish this reply. Please try again.' });
    lastStatus = status;
  }
  async function poll() {
    if (polling || !ready) return;
    polling = true;
    try {
      const result = await history();
      receive(result);
    } catch (error) { emit({ type: 'kasitek:error', message: error.message }); }
    finally { polling = false; }
  }
  async function stream() {
    try {
      const response = await fetch(api + '/sessions/' + session.sessionId + '/events/stream?after=' + cursor,
        { credentials: 'omit', signal: AbortSignal.timeout(70000), headers: { Authorization: 'Bearer ' + session.token } });
      if (!response.ok) {
        if (response.status >= 500 || response.status === 408 || response.status === 429) throw new Error('Website chat temporarily unavailable');
        emit({ type: 'kasitek:error', message: 'Website chat is unavailable or this session has expired.' }); return;
      }
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const next = await reader.read(); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const event = block.split('\n').find(line => line.startsWith('event: '))?.slice(7);
          const data = block.split('\n').find(line => line.startsWith('data: '))?.slice(6);
          if (data && event === 'conversation') receive(JSON.parse(data));
          if (data && event === 'unavailable') {
            const unavailable = JSON.parse(data); emit({ type: 'kasitek:error', message: unavailable.error }); await reader.cancel();
            if (unavailable.retryable) throw new Error(unavailable.error);
            return;
          }
        }
      }
    } catch (_) { emit({ type: 'kasitek:error', message: 'Connection interrupted. Reconnecting…' }); }
    window.setTimeout(stream, 1500);
  }
  async function start() {
    config = await call('/deployments/' + deployment, undefined, false);
    try { session = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (_) {}
    let saved;
    if (session && new Date(session.expiresAt).getTime() > Date.now()) {
      try { saved = await history(); } catch (_) { session = null; }
    } else session = null;
    if (!session) {
      session = await call('/deployments/' + deployment + '/sessions', {}, false);
      try { localStorage.setItem(storageKey, JSON.stringify(session)); } catch (_) {}
      saved = { messages: [], run: null };
    }
    const appearance = config.appearance || {}, color = appearance.primaryColor || '#3730a3';
    const left = config.launcherPosition === 'bottom-left', side = left ? 'left' : 'right';
    const offset = appearance.launcherOffset || 16, size = appearance.launcherSize || 56;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none';
    const launcher = document.createElement('button');
    launcher.type = 'button'; launcher.innerHTML = '<svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8 8.7 8.7 0 0 1-3.7-.8L4 20l1.3-3.4A8 8 0 1 1 20 11.5Z"></path><path d="M8 11.5h.01M12 11.5h.01M16 11.5h.01"></path></svg>'; launcher.setAttribute('aria-label', 'Open ' + config.displayName + ' chat');
    launcher.style.cssText = 'position:absolute;bottom:' + offset + 'px;' + side + ':' + offset + 'px;width:' + size + 'px;height:' + size + 'px;border:1px solid #ffffffb8;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;cursor:pointer;background:' + color + ';pointer-events:auto;box-shadow:0 10px 28px #11182745';
    frame = document.createElement('iframe'); frame.title = config.displayName + ' chat';
    frame.style.cssText = 'position:absolute;bottom:' + offset + 'px;' + side + ':' + offset + 'px;width:' + (appearance.windowWidth || 390) + 'px;height:' + (appearance.windowHeight || 620) + 'px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);border:0;display:none;pointer-events:auto;background:transparent';
    instance.open = () => { frame.style.display = 'block'; launcher.style.display = 'none'; };
    instance.close = () => { frame.style.display = 'none'; launcher.style.display = 'block'; };
    launcher.onclick = instance.open;
    window.addEventListener('message', async event => {
      if (event.source !== frame.contentWindow || event.origin !== base || !event.data) return;
      if (event.data.type === 'kasitek:ready') {
        ready = true; emit({ type: 'kasitek:init', config });
        emit({ type: 'kasitek:history', messages: saved.messages });
        saved.messages.forEach(message => { seen.add(message.id); if (BigInt(message.sequence) > BigInt(cursor)) cursor = message.sequence; });
        if (saved.run && !['completed', 'failed', 'cancelled', 'expired'].includes(saved.run.status)) emit({ type: 'kasitek:pending' });
        stream();
        if (!pollTimer) pollTimer = window.setInterval(poll, 5000);
      }
      if (event.data.type === 'kasitek:close') instance.close();
      if (event.data.type === 'kasitek:toggle-expand') frame.style.height = event.data.expanded ? 'calc(100vh - 32px)' : (appearance.windowHeight || 620) + 'px';
      if (event.data.type === 'kasitek:send' && typeof event.data.text === 'string') {
        try {
          const result = await call('/sessions/' + session.sessionId + '/messages', { text: event.data.text, idempotencyKey: crypto.randomUUID() });
          seen.add(result.messageId);
          emit({ type: 'kasitek:accepted' });
          if (result.status === 'handoff_active') emit({ type: 'kasitek:handoff-active' });
          poll();
        } catch (error) { emit({ type: 'kasitek:error', message: error.message }); }
      }
    });
    overlay.append(launcher, frame); document.body.appendChild(overlay);
    frame.src = api + '/frame.html';
  }
  start().catch(error => {
    const notice = document.createElement('p'); notice.textContent = error.message;
    notice.setAttribute('role', 'alert'); notice.style.cssText = 'position:fixed;bottom:16px;right:16px;padding:12px;background:white;border:1px solid #ddd;z-index:2147483000';
    document.body.appendChild(notice);
  });
})();`;
