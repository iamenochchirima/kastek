const frame = document.getElementById('preview');
const treatments = [...document.querySelectorAll('[data-treatment]')];
const descriptions = {
  calm: 'Shorter travel and quicker reveals. A quiet treatment for the same page.',
  editorial: 'Measured headline reveals, staged product stories and restrained image movement.',
  expressive: 'Longer entrances and more pronounced movement. Compare the pacing with Editorial.',
  off: 'The static design, with all animation disabled.',
};
let mode = 'editorial';
function loadPreview() {
  const url = new URL('../labs-landing/', location.href);
  url.searchParams.set('motion', mode);
  document.getElementById('open-design').href = url.href;
  url.searchParams.set('replay', Date.now());
  frame.src = url.href;
}
for (const button of treatments) button.addEventListener('click', () => {
  mode = button.dataset.treatment;
  treatments.forEach(control => control.setAttribute('aria-pressed', String(control === button)));
  document.getElementById('description').textContent = descriptions[mode];
  loadPreview();
});
document.getElementById('replay').addEventListener('click', loadPreview);
document.getElementById('mobile').addEventListener('click', event => {
  const mobile = document.querySelector('.preview-shell').classList.toggle('mobile');
  event.currentTarget.setAttribute('aria-pressed', String(mobile));
});
document.querySelectorAll('[data-jump]').forEach(button => button.addEventListener('click', () => {
  const target = frame.contentDocument?.getElementById(button.dataset.jump);
  target?.scrollIntoView({ behavior: 'instant', block: 'start' });
}));
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const syncReduced = () => { document.querySelector('.reduced-note').hidden = !reduced.matches; };
reduced.addEventListener('change', syncReduced);
syncReduced();
