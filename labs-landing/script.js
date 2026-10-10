// Local interactions for the saved landing page. No runtime dependencies.
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const preview = button.closest('[data-preview]');
  if (!preview) return;

  let templateId;
  let buttonIndex;
  if (preview.dataset.preview === 'agent') {
    buttonIndex = [...preview.querySelectorAll('.sceneTabs button')].indexOf(button);
    if (buttonIndex < 0) return;
    templateId = buttonIndex === 0 ? 'agent-chat' : 'agent-inbox';
  } else if (preview.dataset.preview === 'growth') {
    buttonIndex = [...preview.querySelectorAll('.sideItems button')].indexOf(button);
    if (buttonIndex < 0) return;
    templateId = buttonIndex === 0 ? 'growth-campaigns' : 'growth-calendar';
  } else if (preview.dataset.preview === 'agency') {
    const palette = button.closest('.palette');
    if (!palette) return;
    preview.querySelector('.agencyScene').style.setProperty('--portal-accent', button.style.backgroundColor);
    for (const swatch of palette.querySelectorAll('button')) {
      const active = swatch === button;
      swatch.setAttribute('aria-pressed', String(active));
      swatch.querySelector('svg')?.remove();
      if (active) {
        swatch.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>';
      }
    }
    return;
  }

  if (!templateId) return;
  const template = document.getElementById(templateId);
  const restoreFocus = document.activeElement === button;
  preview.replaceChildren(template.content.cloneNode(true));
  if (restoreFocus) {
    const selector = preview.dataset.preview === 'agent' ? '.sceneTabs button' : '.sideItems button';
    preview.querySelectorAll(selector)[buttonIndex].focus({ preventScroll: true });
  }
});

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
const copyright = document.querySelector('.footerBottom > span');
copyright.textContent = `© ${new Date().getFullYear()} KasiTek Labs`;
