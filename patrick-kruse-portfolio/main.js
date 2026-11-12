(() => {
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const buttons = [...document.querySelectorAll('[data-theme-choice]')];
  let preference = null;
  try { preference = localStorage.getItem('pk-theme'); } catch {}
  if (!['light', 'dark'].includes(preference)) preference = null;
  function update(theme) {
    root.dataset.theme = theme;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
  }
  update(preference || (system.matches ? 'dark' : 'light'));
  buttons.forEach(button => button.addEventListener('click', () => {
    preference = button.dataset.themeChoice;
    update(preference);
    try { localStorage.setItem('pk-theme', preference); } catch {}
  }));
  system.addEventListener('change', event => {
    if (!preference) update(event.matches ? 'dark' : 'light');
  });
})();

if (document.querySelector('main #projects')) {
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href^="#"]');
    const section = link && document.getElementById(link.hash.slice(1));
    if (!section || link.target === '_blank') return;
    event.preventDefault();
    if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
    if (!section.hasAttribute('tabindex')) section.tabIndex = -1;
    section.focus({preventScroll: true});
    section.scrollIntoView({block: 'start'});
  });
}

const portraitDialog = document.getElementById('portrait-dialog');
if (portraitDialog) {
  const trigger = document.getElementById('portrait-open');
  trigger.addEventListener('click', () => portraitDialog.showModal());
  portraitDialog.querySelector('button').addEventListener('click', () => portraitDialog.close());
  portraitDialog.addEventListener('click', event => {
    if (event.target === portraitDialog) portraitDialog.close();
  });
  portraitDialog.addEventListener('close', () => trigger.focus({preventScroll: true}));
}

for (const portrait of document.querySelectorAll('#portrait-open, #portrait-dialog img')) {
  portrait.addEventListener('contextmenu', event => event.preventDefault());
  portrait.addEventListener('dragstart', event => event.preventDefault());
}
