/** Authored landing animations, scoped to one mounted landing page. */
export function initializeAgents(runtime) {
  const { root, shared, listen, frame, observe, byId } = runtime;
// Automatically present the examples while this section is being viewed.

  const preview = byId('agent-demo');
  const choices = ['support', 'business', 'personal'];
  const control = root.querySelector('[data-agent-autoplay]');
  const label = control.querySelector('[data-autoplay-label]');
  const icon = control.querySelector('[data-autoplay-icon]');
  const sceneLabel = root.querySelector('[data-agent-scene-label]');
  const sceneNames = { support: 'Customer support', business: 'Business agents', personal: 'Personal agents' };
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const duration = { support: 13000, business: 14000, personal: 15000 };
  let visible = false;
  let userPaused = false;
  let elapsed = 0;
  let previousTime = performance.now();
  let selected = 'support';
  let firstEntry = true;
  const disabled = () => preference.matches || root.dataset.motion === 'off';
  const focused = () => Boolean(document.activeElement?.closest('#agent-demo'));
  function updateControl() {
    const stopped = userPaused || disabled();
    control.setAttribute('aria-pressed', String(stopped));
    label.textContent = disabled() ? 'Motion off' : stopped ? 'Play demo' : 'Pause demo';
    icon.textContent = disabled() ? '' : stopped ? '▷' : 'Ⅱ';
    control.disabled = disabled();
    control.setAttribute('aria-label', disabled() ? 'Motion off for Agents demo' : stopped ? 'Play demo for Agents' : 'Pause demo for Agents');
    control.title = disabled() ? 'Automatic motion is off with your current motion preference.' : '';
  }
  function tick(now) {
    const delta = Math.min(now - previousTime, 250);
    previousTime = now;
    const running = visible && !userPaused && !focused() && !document.hidden && !disabled();
    if (running) elapsed += delta;
    if (elapsed >= duration[selected]) {
      const next = (choices.indexOf(selected) + 1) % choices.length;
      shared.agents.select(choices[next], { automatic: true });
    }
    frame(tick);
  }
  observe(entries => {
    visible = entries[0].isIntersecting;
    if (visible && firstEntry) {
      firstEntry = false;
      ['business', 'personal'].forEach(kind => {
        const photo = byId(`agent-${kind}`).querySelector('.operation-photo');
        const image = new Image();
        image.src = photo.src;
      });
      // Start the first operation when the actual stage becomes visible.
      if (!disabled()) root.dispatchEvent(new CustomEvent('labs:previewchange', { detail: { preview } }));
    }
    shared.motion?.setPaused(preview, userPaused || !visible || document.hidden);
  }, { threshold: 0.12 }).observe(preview);
  listen(root.querySelector('[data-agent-next]'), 'click', () => {
    shared.agents.select(choices[(choices.indexOf(selected) + 1) % choices.length]);
  });
  listen(control, 'click', () => {
    userPaused = !userPaused;
    shared.motion?.setPaused(preview, userPaused);
    updateControl();
  });
  listen(root, 'labs:agentselected', event => {
    selected = event.detail.selected;
    sceneLabel.textContent = sceneNames[selected];
    elapsed = 0;
    if (userPaused) shared.motion?.stop(preview);
    shared.motion?.setPaused(preview, userPaused || !visible || document.hidden);
  });
  listen(root, 'click', event => {
    if (event.target.closest('#agents [data-replay]')) {
      elapsed = 0; userPaused = false; updateControl();
      shared.motion?.setPaused(preview, !visible || document.hidden);
    }
  });
  listen(document, 'visibilitychange', () => shared.motion?.setPaused(preview, userPaused || document.hidden || !visible));
  listen(preference, 'change', () => { elapsed = 0; updateControl(); });
  updateControl();
  frame(tick);

}
