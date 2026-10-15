// Automatically present the examples while this section is being viewed.
(() => {
  const preview = document.getElementById('agent-demo');
  const choices = ['support', 'business', 'personal'];
  const control = document.querySelector('[data-agent-autoplay]');
  const label = control.querySelector('[data-autoplay-label]');
  const icon = control.querySelector('[data-autoplay-icon]');
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const duration = { support: 13000, business: 14000, personal: 15000 };
  let visible = false;
  let userPaused = false;
  let elapsed = 0;
  let previousTime = performance.now();
  let selected = 'support';
  let firstEntry = true;
  const disabled = () => preference.matches || document.documentElement.dataset.motion === 'off';
  const focused = () => Boolean(document.activeElement?.closest('#agent-demo'));
  function updateControl() {
    const stopped = userPaused || disabled();
    control.setAttribute('aria-pressed', String(stopped));
    label.textContent = stopped ? 'Play sequence' : 'Pause sequence';
    icon.textContent = stopped ? '▷' : 'Ⅱ';
    control.disabled = disabled();
    control.title = disabled() ? 'Automatic motion is off with your current motion preference.' : '';
  }
  function tick(now) {
    const delta = Math.min(now - previousTime, 250);
    previousTime = now;
    const running = visible && !userPaused && !focused() && !document.hidden && !disabled();
    if (running) elapsed += delta;
    if (elapsed >= duration[selected]) {
      const next = (choices.indexOf(selected) + 1) % choices.length;
      window.LabsAgents.select(choices[next], { automatic: true });
    }
    requestAnimationFrame(tick);
  }
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible && firstEntry) {
      firstEntry = false;
      ['business', 'personal'].forEach(kind => {
        const photo = document.getElementById(`agent-${kind}`).content.querySelector('.operation-photo');
        const image = new Image();
        image.src = photo.src;
      });
      // Start the first operation when the actual stage becomes visible.
      if (!disabled()) document.dispatchEvent(new CustomEvent('labs:previewchange', { detail: { preview } }));
    }
    window.LabsMotion?.setPaused(preview, userPaused || !visible || document.hidden);
  }, { threshold: 0.12 }).observe(preview);
  document.querySelector('[data-agent-next]').addEventListener('click', () => {
    window.LabsAgents.select(choices[(choices.indexOf(selected) + 1) % choices.length]);
  });
  control.addEventListener('click', () => {
    userPaused = !userPaused;
    window.LabsMotion?.setPaused(preview, userPaused);
    updateControl();
  });
  document.addEventListener('labs:agentselected', event => {
    selected = event.detail.selected;
    elapsed = 0;
    window.LabsMotion?.setPaused(preview, !visible || document.hidden);
  });
  document.addEventListener('click', event => {
    if (event.target.closest('#agents [data-replay]')) { elapsed = 0; window.LabsMotion?.setPaused(preview, false); }
  });
  document.addEventListener('visibilitychange', () => window.LabsMotion?.setPaused(preview, userPaused || document.hidden || !visible));
  preference.addEventListener('change', () => { elapsed = 0; updateControl(); });
  updateControl();
  requestAnimationFrame(tick);
})();
