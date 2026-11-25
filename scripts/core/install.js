const button = document.querySelector('[data-install]');
const dialog = document.querySelector('[data-install-dialog]');
const help = document.querySelector('[data-install-help]');
const standalone = window.matchMedia('(display-mode: standalone)');
const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let promptEvent = null;
let installed = false;
let prompting = false;
function refresh() {
  if (button) button.hidden = installed || standalone.matches || navigator.standalone === true;
}
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  promptEvent = event;
  refresh();
});
window.addEventListener('appinstalled', () => {
  installed = true;
  promptEvent = null;
  refresh();
});
standalone.addEventListener?.('change', refresh);
window.addEventListener('pageshow', refresh);
button?.addEventListener('click', async () => {
  if (prompting) return;
  if (promptEvent) {
    const pending = promptEvent;
    promptEvent = null;
    prompting = true;
    try {
      await pending.prompt();
      const result = await pending.userChoice;
      if (result?.outcome === 'accepted') installed = true;
      refresh();
      return;
    } catch { /* use manual installation instructions */ }
    finally { prompting = false; }
  }
  const instructions = ios
    ? 'Открой книгу в Safari. Нажми «Поделиться», затем «На экран Домой». Если есть переключатель «Открывать как веб-приложение», включи его. Нажми «Добавить».'
    : /Android/i.test(navigator.userAgent)
      ? 'Открой книгу в Chrome. В меню браузера (⋮) выбери «Установить приложение» или «Добавить на главный экран». Название пункта зависит от браузера.'
      : 'В Chrome или Edge проверь значок установки в адресной строке или пункт установки приложения в меню браузера. На телефоне можно добавить книгу на главный экран через меню браузера.';
  help.textContent = instructions;
  if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
  else window.alert(instructions);
});
refresh();
