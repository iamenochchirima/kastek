/** Authored landing animations, scoped to one mounted landing page. */
export function initializeInteractions(runtime) {
  const { root, shared, gsap, listen, cleanup, byId } = runtime;
// Illustrative product previews. Product navigation uses ordinary section anchors.
root.querySelectorAll('.productMenu a').forEach(link => {
  listen(link, 'click', () => link.closest('details').removeAttribute('open'));
});
listen(document, 'pointerdown', event => {
  const menu = root.querySelector('.productMenu[open]');
  if (menu && !menu.contains(event.target)) menu.removeAttribute('open');
});
listen(document, 'keydown', event => {
  if (event.key === 'Escape') {
    const menu = root.querySelector('.productMenu[open]');
    if (menu) {
      menu.removeAttribute('open');
      menu.querySelector('summary').focus();
    }
  }
});
const copyright = root.querySelector('[data-copyright]');
copyright.textContent = `© ${new Date().getFullYear()} KasiTek Labs`;

// Manual and automatic scene changes share the same selection path.
{
  const preview = byId('agent-demo');
  const initialScene = preview.innerHTML;
  cleanup(() => { transition?.kill(); preview.innerHTML = initialScene; preview.classList.remove('op-typing'); });
  let transition;
  let current = 'support';
  const names = { support: 'Customer support', business: 'Business', personal: 'Personal' };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function select(selected, { automatic = false } = {}) {
    if (!names[selected]) return;
    if (current === selected) {
      root.dispatchEvent(new CustomEvent('labs:agentselected', { detail: { selected, automatic } }));
      return;
    }
    transition?.progress(1).kill();
    shared.motion?.stop(preview);
    const outgoing = preview.firstElementChild.cloneNode(true);
    outgoing.classList.add('agent-outgoing');
    outgoing.setAttribute('aria-hidden', 'true');
    outgoing.inert = true;
    preview.replaceChildren(byId(`agent-${selected}`).firstElementChild.cloneNode(true));
    current = selected;
    preview.setAttribute('aria-label', `${names[selected]} example`);
    // Announce manual choices; repeated autoplay announcements would interrupt reading.
    if (!automatic) root.querySelector('[data-agent-status]').textContent = `${names[selected]} example selected.`;
    const incoming = preview.firstElementChild;
    const phoneChat = incoming.querySelector('.phone-chat');
    if (phoneChat && (reducedMotion.matches || root.dataset.motion === 'off')) phoneChat.scrollTop = phoneChat.scrollHeight;
    if (gsap && !reducedMotion.matches && root.dataset.motion !== 'off') {
      preview.append(outgoing);
      transition = gsap.timeline({ onComplete: () => { outgoing.remove(); incoming.style.removeProperty('opacity'); incoming.style.removeProperty('visibility'); } });
      transition.fromTo(incoming, { opacity: 0 }, { opacity: 1, duration: 0.8, ease: 'power2.inOut' }, 0)
        .to(outgoing, { opacity: 0, duration: 0.8, ease: 'power2.inOut' }, 0);
    }
    root.dispatchEvent(new CustomEvent('labs:previewchange', { detail: { preview } }));
    root.dispatchEvent(new CustomEvent('labs:agentselected', { detail: { selected, automatic } }));
  }
  listen(reducedMotion, 'change', () => transition?.progress(1).kill());
  shared.agents = { select, finishTransition: () => transition?.progress(1).kill() };
}

}
