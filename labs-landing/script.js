// Illustrative product previews. Product navigation uses ordinary section anchors.
document.querySelectorAll('.productMenu a').forEach(link => {
  link.addEventListener('click', () => link.closest('details').removeAttribute('open'));
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    const menu = document.querySelector('.productMenu[open]');
    if (menu) {
      menu.removeAttribute('open');
      menu.querySelector('summary').focus();
    }
  }
});
const copyright = document.querySelector('[data-copyright]');
copyright.textContent = `© ${new Date().getFullYear()} KasiTek Labs`;

// Manual and automatic scene changes share the same selection path.
(() => {
  const preview = document.getElementById('agent-demo');
  let transition;
  let current = 'support';
  const names = { support: 'Customer support', business: 'Business', personal: 'Personal' };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function select(selected, { automatic = false } = {}) {
    if (!names[selected]) return;
    if (current === selected) {
      document.dispatchEvent(new CustomEvent('labs:agentselected', { detail: { selected, automatic } }));
      return;
    }
    transition?.progress(1).kill();
    window.LabsMotion?.stop(preview);
    const outgoing = preview.firstElementChild.cloneNode(true);
    outgoing.classList.add('agent-outgoing');
    outgoing.setAttribute('aria-hidden', 'true');
    outgoing.inert = true;
    preview.replaceChildren(document.getElementById(`agent-${selected}`).content.cloneNode(true));
    current = selected;
    preview.setAttribute('aria-label', `${names[selected]} example`);
    // Announce manual choices; repeated autoplay announcements would interrupt reading.
    if (!automatic) document.querySelector('[data-agent-status]').textContent = `${names[selected]} example selected.`;
    const incoming = preview.firstElementChild;
    const phoneChat = incoming.querySelector('.phone-chat');
    if (phoneChat && (reducedMotion.matches || document.documentElement.dataset.motion === 'off')) phoneChat.scrollTop = phoneChat.scrollHeight;
    if (window.gsap && !reducedMotion.matches && document.documentElement.dataset.motion !== 'off') {
      preview.append(outgoing);
      transition = gsap.timeline({ onComplete: () => { outgoing.remove(); incoming.style.removeProperty('opacity'); incoming.style.removeProperty('visibility'); } });
      transition.fromTo(incoming, { opacity: 0 }, { opacity: 1, duration: 0.8, ease: 'power2.inOut' }, 0)
        .to(outgoing, { opacity: 0, duration: 0.8, ease: 'power2.inOut' }, 0);
    }
    document.dispatchEvent(new CustomEvent('labs:previewchange', { detail: { preview } }));
    document.dispatchEvent(new CustomEvent('labs:agentselected', { detail: { selected, automatic } }));
  }
  reducedMotion.addEventListener('change', () => transition?.progress(1).kill());
  window.LabsAgents = { select, finishTransition: () => transition?.progress(1).kill() };
})();
