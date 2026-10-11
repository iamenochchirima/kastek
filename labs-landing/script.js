// Illustrative product previews. Product navigation uses ordinary section anchors.
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const category = button.closest('[data-agent-choice]');
  if (category) {
    const preview = document.getElementById('agent-demo');
    const selected = category.dataset.agentChoice;
    if (category.getAttribute('aria-pressed') === 'true') return;
    window.LabsMotion?.stop(preview);
    preview.replaceChildren(document.getElementById(`agent-${selected}`).content.cloneNode(true));
    preview.setAttribute('aria-labelledby', category.id);
    document.querySelectorAll('[data-agent-choice]').forEach(choice => choice.setAttribute('aria-pressed', String(choice === category)));
    document.querySelector('[data-agent-status]').textContent = `${category.querySelector('.agent-choice-name').firstChild.textContent.trim()} example selected.`;
    document.dispatchEvent(new CustomEvent('labs:previewchange', { detail: { preview } }));
    return;
  }
  const preview = button.closest('[data-preview]');
  if (!preview) return;

  let templateId;
  let buttonIndex;
  if (preview.dataset.preview === 'growth') {
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
    document.dispatchEvent(new CustomEvent('labs:brandchange', { detail: { preview } }));
    return;
  }

  if (!templateId) return;
  const template = document.getElementById(templateId);
  window.LabsMotion?.stop(preview);
  const restoreFocus = document.activeElement === button;
  preview.replaceChildren(template.content.cloneNode(true));
  if (restoreFocus) {
    const selector = '.sideItems button';
    preview.querySelectorAll(selector)[buttonIndex].focus({ preventScroll: true });
  }
  document.dispatchEvent(new CustomEvent('labs:previewchange', { detail: { preview } }));
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
const copyright = document.querySelector('[data-copyright]');
copyright.textContent = `© ${new Date().getFullYear()} KasiTek Labs`;

// Arrow keys offer a shortcut between the category buttons; Tab reaches each one.
document.querySelector('.agent-choices').addEventListener('keydown', event => {
  const choices = [...document.querySelectorAll('[data-agent-choice]')];
  const current = choices.indexOf(event.target.closest('[data-agent-choice]'));
  if (current < 0 || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (current + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + choices.length) % choices.length;
  choices[next].focus({ preventScroll: true });
  choices[next].click();
});
