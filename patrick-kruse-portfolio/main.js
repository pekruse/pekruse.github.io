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
