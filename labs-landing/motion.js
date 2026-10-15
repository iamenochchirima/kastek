/* Authored motion for the Labs design. All content works without this file. */
(() => {
  if (!window.gsap || !window.ScrollTrigger) return;
  const { gsap, ScrollTrigger } = window;
  gsap.registerPlugin(ScrollTrigger);

  const requested = new URLSearchParams(location.search).get('motion');
  const treatments = {
    calm: { distance: 18, duration: 0.65, stagger: 0.12, imageScale: 1.025 },
    editorial: { distance: 42, duration: 1.05, stagger: 0.2, imageScale: 1.055 },
    expressive: { distance: 68, duration: 1.35, stagger: 0.26, imageScale: 1.085 },
  };
  const mode = requested in treatments ? requested : 'editorial';
  const recipe = treatments[mode];
  document.documentElement.dataset.motion = requested === 'off' ? 'off' : mode;
  if (requested === 'off') return;

  const scenes = new WeakMap();
  let active = false;
  let context;
  function inContext(callback) {
    if (active) context.add(callback);
  }
  function stopScene(preview) {
    const previous = scenes.get(preview);
    if (previous) { previous.progress(1); previous.kill(); scenes.delete(preview); }
  }
  function scene(preview, replacing = false) {
    if (!active || !preview || preview.dataset.sequence) return;
    stopScene(preview);
    const sceneRoot = preview.dataset.preview === 'agent' ? preview.firstElementChild : preview;
    const find = selector => sceneRoot.querySelectorAll(selector);
    const tl = gsap.timeline({ defaults: { ease: 'power3.out', duration: recipe.duration } });
    scenes.set(preview, tl);
    if (preview.dataset.preview === 'agent') {
      const kind = preview.querySelector('[data-agent-scene]').dataset.agentScene;
      const status = preview.querySelector('.op-status');
      status.dataset.finalStatus ||= status.textContent;
      tl.call(() => { status.textContent = 'Working…'; preview.classList.add('op-typing'); }, null, 0)
        .from(find(kind === 'personal' ? '.personal-phone' : '.operation-window'), { y: 22, autoAlpha: 0, duration: 1 }, 0)
;
      if (find('.op-progress').length) tl.fromTo(find('.op-progress'), { scaleX: 0 }, { scaleX: 1, duration: 7, ease: 'none' }, 0);
      if (replacing) tl.fromTo(find('.operation-photo'), { scale: 1.035 }, { scale: 1, duration: 6, ease: 'power1.out' }, 0);
      find('.op-step').forEach((step, i) => tl.from(step, { y: 6, autoAlpha: 0, duration: 0.35 }, 0.8 + i * 1.25));
      if (kind === 'support') {
        tl.from(find('.op-incoming'), { y: 12, autoAlpha: 0, duration: 0.65 }, 0.5)
          .from(find('.op-order'), { y: 8, autoAlpha: 0, duration: 0.6 }, 1.3)
          .from(find('.op-response'), { y: 10, autoAlpha: 0, duration: 0.6 }, 2.6)
          .from(find('.op-source-chip'), { autoAlpha: 0, duration: 0.5 }, 4.8)
          .from(find('.op-human-note'), { y: 7, autoAlpha: 0, duration: 0.6 }, 5.8);
      } else if (kind === 'business') {
        tl.from(find('.op-request-bar'), { y: 8, autoAlpha: 0, duration: 0.6 }, 0.5)
          .from(find('.op-calendar-event'), { scaleY: 0.2, autoAlpha: 0, transformOrigin: 'top', duration: 0.85 }, 2.1)
          .from(find('.op-approval'), { y: 8, autoAlpha: 0, duration: 0.7 }, 3.1)
          .from(find('.op-approval-action'), { scale: 0.9, autoAlpha: 0, duration: 0.5 }, 3.5)
          .fromTo(find('.op-demo-cursor'), { x: 30, y: 25, opacity: 0 }, { x: 0, y: 0, opacity: 1, duration: 0.65 }, 3.7)
          .to(find('.op-demo-cursor'), { scale: 0.82, repeat: 1, yoyo: true, duration: 0.13 }, 4.4)
          .to(find('.op-demo-cursor'), { opacity: 0, duration: 0.3 }, 4.9)
          .from(find('.op-success'), { y: 8, autoAlpha: 0, duration: 0.7 }, 5.8);
      } else {
        tl.from(find('.phone-context'), { y: 6, autoAlpha: 0, duration: 0.5 }, 0.5)
          .from(find('.phone-user-message'), { y: 10, autoAlpha: 0, duration: 0.65 }, 1)
          .from(find('.phone-agent-message'), { y: 10, autoAlpha: 0, duration: 0.6 }, 2.4)
          .from(find('.phone-brief'), { y: 16, autoAlpha: 0, duration: 0.9 }, 4.6)
          .from(find('.phone-brief-line'), { y: 5, autoAlpha: 0, stagger: 0.25, duration: 0.5 }, 5)
          .from(find('.phone-delivered'), { autoAlpha: 0, duration: 0.5 }, 6.2)
          .from(find('.personal-outcome'), { x: 12, autoAlpha: 0, rotation: -5, duration: 0.9 }, 5.8)
          .from(find('.personal-check'), { y: 4, autoAlpha: 0, stagger: 0.2, duration: 0.5 }, 6);
        const chat = sceneRoot.querySelector('.phone-chat');
        tl.set(chat, { scrollTop: 0 }, 0)
          .to(chat, { scrollTop: () => chat.scrollHeight - chat.clientHeight, duration: 1.5, ease: 'power2.inOut' }, 5.1);
      }
      if (kind === 'business') {
        const approval = preview.querySelector('.op-approval-action');
        tl.call(() => { approval.textContent = 'Review & approve'; status.textContent = 'Needs approval'; }, null, 3.1)
          .call(() => { approval.textContent = approval.dataset.finalAction; status.textContent = 'Creating event…'; }, null, 4.6);
      } else {
        tl.call(() => { status.textContent = kind === 'support' ? 'Searching knowledge…' : 'Reading files…'; }, null, 1.3)
          .call(() => { status.textContent = kind === 'support' ? 'Writing reply…' : 'Writing brief…'; }, null, 2.6);
      }
      find('[data-typed]').forEach(node => {
        const state = { characters: 0 };
        const copy = node.dataset.typed;
        tl.fromTo(state, { characters: 0 }, { characters: copy.length, duration: 2.5, ease: 'none', onUpdate: () => { node.textContent = copy.slice(0, Math.floor(state.characters)); } }, kind === 'support' ? 2.7 : 2.5);
      });
      if (find('.op-run-complete').length) tl.from(find('.op-run-complete'), { y: 5, autoAlpha: 0, duration: 0.5 }, 6.5);
      tl.call(() => { status.textContent = status.dataset.finalStatus; preview.classList.remove('op-typing'); }, null, 7);
    } else if (preview.dataset.preview === 'growth') {
      if (!replacing) tl.from(find('.growthWindow'), { y: recipe.distance * 0.6, autoAlpha: 0 }, 0);
      tl.from(find('.campaignCard, .calendarPreview > div'), { y: recipe.distance * 0.6, autoAlpha: 0, stagger: recipe.stagger, duration: 0.8 }, replacing ? 0 : 0.3);
      if (find('.scheduleNote').length) tl.from(find('.scheduleNote'), { x: -22, autoAlpha: 0 }, 1.25);
    } else if (preview.dataset.preview === 'agency') {
      tl.from(find('.agencyManager'), { x: -recipe.distance, autoAlpha: 0 }, 0)
        .from(find('.businessRow'), { x: -12, autoAlpha: 0, stagger: recipe.stagger, duration: 0.7 }, 0.3)
        .from(find('.clientPortal'), { x: recipe.distance, autoAlpha: 0 }, 0.65)
        .from(find('.portalBody > *, .palette'), { y: 12, autoAlpha: 0, stagger: 0.1, duration: 0.6 }, 1);
    }
    return tl;
  }

  const media = gsap.matchMedia();
  media.add({ motion: '(prefers-reduced-motion: no-preference)', desktop: '(min-width: 761px)' }, current => {
    if (!current.conditions.motion) return;
    context = current;
    active = true;
    const desktop = current.conditions.desktop;
    document.documentElement.classList.add('motion-enabled');

    // Split only explicit headline lines. Existing italic markup stays intact.
    const heading = document.querySelector('.opening h1');
    const original = heading.innerHTML;
    heading.innerHTML = original.split(/<br\s*\/?\s*>/i).map(line => `<span class="motion-line-mask"><span class="motion-line">${line}</span></span>`).join('');
    const hero = gsap.timeline({ defaults: { ease: 'power3.out', duration: recipe.duration } });
    hero.from('.opening-image', { scale: recipe.imageScale, duration: 3.6, ease: 'power2.out' }, 0)
      .from('.site-header', { y: -12, autoAlpha: 0, duration: 0.8 }, 0.1)
      .from('.opening-copy .eyebrow', { y: 10, autoAlpha: 0 }, 0.2)
      .from('.motion-line', { yPercent: 112, stagger: recipe.stagger, duration: recipe.duration + 0.15 }, 0.3)
      .from('.opening-description, .opening-copy .button', { y: 20, autoAlpha: 0, stagger: 0.12 }, 0.9)
      .from('.conversation-label', { autoAlpha: 0, duration: 0.6 }, 1.2)
      .from('.conversation-message.customer', { y: 18, autoAlpha: 0, duration: 0.7 }, 1.45)
      .from('.conversation-message.agent', { y: 20, autoAlpha: 0, duration: 0.9 }, 2.3)
      .from('.conversation-note, .opening-bottom', { autoAlpha: 0, duration: 0.7 }, 2.7);

    // Image-only parallax preserves normal document scrolling.
    if (desktop) gsap.to('.opening-image', { yPercent: 7, ease: 'none', scrollTrigger: { trigger: '.opening', start: 'top top', end: 'bottom top', scrub: 0.7 } });
    gsap.from('.directoryItem', { y: 18, autoAlpha: 0, stagger: 0.1, duration: 0.8, scrollTrigger: { trigger: '.productDirectory', start: 'top 94%', once: true } });
    document.querySelectorAll('.product-panel').forEach(panel => {
      gsap.from(panel.querySelectorAll('.product-label, .feature-heading h2, .feature-heading > div'), { y: recipe.distance * 0.6, autoAlpha: 0, stagger: 0.13, duration: recipe.duration, ease: 'power3.out', scrollTrigger: { trigger: panel, start: 'top 86%', once: true } });
      const preview = panel.querySelector('[data-preview]');
      if (preview) ScrollTrigger.create({ trigger: preview.querySelector('.operation-window') || panel.querySelector('.showcase-stage'), start: 'top 78%', once: true, onEnter: () => inContext(() => scene(preview)) });
    });
    const service = gsap.timeline({ defaults: { duration: recipe.duration, ease: 'power3.out' }, scrollTrigger: { trigger: '.services', start: 'top 85%', once: true } });
    service.from('.servicesImage img', { scale: 1.08, duration: 1.8 }, 0)
      .from('.servicesCopy .sectionLabel, .servicesCopy h2', { y: 22, autoAlpha: 0, stagger: 0.15 }, 0.15)
      .from('.servicesCopy h2 em', { autoAlpha: 0, duration: 0.75 }, 1.1)
      .from('.servicesCopy > p:not(.sectionLabel), .servicesCopy .textLink', { y: 14, autoAlpha: 0, stagger: 0.12 }, 0.85);

    // Interaction timelines are tracked by the media context too.
    const replay = event => {
      const button = event.target.closest('[data-replay]');
      if (button) inContext(() => scene(button.closest('.product-panel').querySelector('[data-preview]')));
    };
    const changed = event => inContext(() => { scene(event.detail.preview, true); ScrollTrigger.refresh(); });
    const brand = event => inContext(() => {
      const preview = event.detail.preview;
      stopScene(preview);
      gsap.fromTo(preview.querySelectorAll('.portalBody h3, .portalTiles > div'), { y: 8, opacity: 0.6 }, { y: 0, opacity: 1, duration: 0.55, stagger: 0.07, ease: 'power2.out', overwrite: true });
    });
    document.addEventListener('click', replay);
    document.addEventListener('labs:previewchange', changed);
    document.addEventListener('labs:brandchange', brand);
    const focus = event => {
      const preview = event.target.closest('[data-preview]');
      if (preview && !event.target.closest('#agents [data-replay]')) stopScene(preview);
    };
    document.addEventListener('focusin', focus);
    return () => {
      document.querySelectorAll('[data-typed]').forEach(node => { node.textContent = node.dataset.typed; });
      document.querySelectorAll('[data-final-action]').forEach(node => { node.textContent = node.dataset.finalAction; });
      document.querySelectorAll('.op-status[data-final-status]').forEach(node => { node.textContent = node.dataset.finalStatus; });
      document.querySelectorAll('.op-typing').forEach(node => node.classList.remove('op-typing'));
      active = false;
      document.documentElement.classList.remove('motion-enabled');
      heading.innerHTML = original;
      document.removeEventListener('click', replay);
      document.removeEventListener('labs:previewchange', changed);
      document.removeEventListener('labs:brandchange', brand);
      document.removeEventListener('focusin', focus);
    };
  });
  window.LabsMotion = { stop: stopScene, mode, enabled: () => active, setPaused: (preview, paused) => { scenes.get(preview)?.paused(paused); } };
  window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
})();
