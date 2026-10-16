// Illustrative frontend operations. The workspace shell stays fixed between views.
(() => {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const motionOff = () => preference.matches || new URLSearchParams(location.search).get('motion') === 'off';
  document.querySelectorAll('[data-sequence]').forEach(stage => {
    const kind = stage.dataset.sequence;
    const states = kind === 'growth' ? ['conversation', 'campaign', 'schedule'] : ['portfolio', 'identity', 'client'];
    const durations = kind === 'growth' ? [10000, 12000, 12000] : [10000, 11000, 12000];
    const section = stage.closest('.product-panel');
    const controls = section.querySelector('.pr-controls');
    const pause = controls.querySelector('[data-sequence-pause]');
    const status = section.querySelector('[data-sequence-status]');
    let current = 0, elapsed = 0, visible = false, paused = false, last = performance.now();
    let accent = '#6f7695';
    function syncMotion() {
      stage.classList.toggle('is-playing', !motionOff());
      stage.classList.toggle('is-paused', paused || !visible || document.hidden);
      pause.disabled = motionOff();
      pause.setAttribute('aria-pressed', String(paused || motionOff()));
      pause.innerHTML = motionOff() ? 'Motion off' : paused ? '▷ <span>Play</span>' : 'Ⅱ <span>Pause</span>';
    }
    function front(client) {
      stage.dataset.front = client;
      stage.querySelectorAll('[data-client]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.client === client)));
      stage.querySelectorAll('[data-portal]').forEach(portal => {
        const active = portal.dataset.portal === client;
        portal.inert = !active;
        portal.setAttribute('aria-hidden', String(!active));
      });
    }
    function brand(value) {
      accent = value;
      stage.style.setProperty('--agency-accent', accent);
      stage.dataset.branded = 'true';
      stage.querySelectorAll('[data-accent]').forEach(button => {
        const selected = button.dataset.accent === accent;
        button.setAttribute('aria-pressed', String(selected));
        button.textContent = selected ? '✓' : '';
      });
    }
    function select(index, { automatic = false, client } = {}) {
      current = index;
      elapsed = 0;
      stage.dataset.state = states[current];
      stage.dataset.scrolled = 'false';
      stage.classList.remove('is-playing');
      if (kind === 'growth') {
        stage.querySelectorAll('[data-sequence-view]').forEach(view => {
          const active = view.dataset.sequenceView === states[current];
          view.hidden = !active;
          view.inert = !active;
          view.classList.toggle('is-active', active);
        });
        stage.querySelectorAll('[data-growth-note]').forEach(note => note.hidden = note.dataset.growthNote !== states[current]);
        stage.querySelectorAll('[data-sequence-select]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.sequenceSelect) === current)));
        stage.querySelector('.gr-campaign').scrollTop = 0;
      } else {
        const identity = stage.querySelector('.ag-identity');
        identity.hidden = current !== 1;
        identity.inert = current !== 1;
        front(client || (current === 2 ? 'dental' : 'acorn'));
        stage.dataset.branded = String(current === 2 || (current === 1 && motionOff()));
        stage.style.setProperty('--agency-accent', accent);
      }
      // Restart only authored entrance animations, retaining the shell and portal positions.
      void stage.offsetWidth;
      syncMotion();
      if (!automatic) status.textContent = `${kind === 'growth' ? 'Growth' : 'Agency'} ${states[current]} view selected.`;
    }
    section.addEventListener('click', event => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target.matches('[data-sequence-pause]')) { paused = !paused; syncMotion(); }
      else if (target.matches('[data-sequence-next]')) select((current + 1) % states.length);
      else if (target.matches('[data-sequence-replay]')) select(0);
      else if (target.matches('[data-sequence-select]')) select(Number(target.dataset.sequenceSelect));
      else if (target.matches('[data-client]')) select(target.dataset.client === 'acorn' ? 0 : 2, { client: target.dataset.client });
      else if (target.matches('[data-accent]')) brand(target.dataset.accent);
    });
    new IntersectionObserver(entries => { visible = entries[0].isIntersecting; syncMotion(); }, { threshold: .15 }).observe(stage);
    document.addEventListener('visibilitychange', syncMotion);
    preference.addEventListener('change', () => { elapsed = 0; if (kind === 'agency' && current === 1 && motionOff()) brand(accent); syncMotion(); });
    function tick(now) {
      const delta = Math.min(now - last, 200); last = now;
      const focused = stage.contains(document.activeElement);
      if (visible && !paused && !document.hidden && !motionOff()) {
        // Finish the operation while focused, but never replace the user's focused view.
        elapsed += delta;
        if (kind === 'growth' && current === 1 && elapsed >= 5000 && stage.dataset.scrolled !== 'true') {
          const editor = stage.querySelector('.gr-campaign');
          if (editor.scrollHeight > editor.clientHeight) editor.scrollTo({ top: editor.scrollHeight, behavior: 'smooth' });
          stage.dataset.scrolled = 'true';
        }
        if (kind === 'agency' && current === 1 && elapsed >= 1800 && stage.dataset.branded !== 'true') brand(accent);
        if (!focused && elapsed >= durations[current]) select((current + 1) % states.length, { automatic: true });
      }
      requestAnimationFrame(tick);
    }
    syncMotion();
    requestAnimationFrame(tick);
  });
})();
