import { getState } from '../core/storage.js';
const routes = new Set(['about', 'author', 'feedback']);
const telegram = 'https://t.me/iterevsky_kochetov';
export const isInfoRoute = screen => routes.has(screen);
export function formatFeedback({ type, chapter, message, environment, build }) {
  const label = {typo:'Опечатка',technical:'Техническая ошибка',message:'Сообщение автору'}[type] || 'Сообщение автору';
  const lines = [`ЭХО · ${label}`];
  if (Number.isSafeInteger(Number(chapter)) && Number(chapter)>0) lines.push(`Глава: ${Number(chapter)}`);
  if (type === 'technical') {
    lines.push(`Версия: ${build}`);
    if (environment.trim()) lines.push(`Устройство / браузер: ${environment.trim()}`);
  }
  if (message.trim()) lines.push('',message.trim());
  return lines.join('\n');
}
export function createInfoScreen(root, { onBack }) {
  const scroll = root.querySelector('#info-scroll');
  const pages = [...root.querySelectorAll('[data-info-page]')];
  const form = root.querySelector('[data-feedback-form]');
  const type = form.querySelector('#feedback-type');
  const chapter = form.querySelector('#feedback-chapter');
  const message = form.querySelector('#feedback-message');
  const environment = form.querySelector('#feedback-environment');
  const preview = form.querySelector('#feedback-preview');
  const link = form.querySelector('[data-feedback-telegram]');
  const status = form.querySelector('[data-feedback-status]');
  const current = form.querySelector('[data-feedback-current]');
  let active = null;
  function update() {
    form.querySelector('[data-feedback-technical]').hidden = type.value !== 'technical';
    const build = document.querySelector('meta[name="echo-build"]')?.content || 'неизвестна';
    preview.value = formatFeedback({type:type.value,chapter:chapter.validity.valid?chapter.value:'',message:message.value,environment:environment.value,build});
    link.href = `${telegram}?text=${encodeURIComponent(preview.value)}`;
    status.textContent = '';
  }
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  current.addEventListener('click', () => {chapter.value = getState().currentChapterNumber || ''; update();});
  form.querySelector('[data-feedback-copy]').addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
      await navigator.clipboard.writeText(preview.value);
      status.textContent = 'Сообщение скопировано.';
    } catch {
      preview.focus(); preview.select(); preview.setSelectionRange(0,preview.value.length);
      status.textContent = 'Автоматическое копирование недоступно. Текст выделен: скопируйте его вручную.';
    }
  });
  root.querySelectorAll('[data-info-back]').forEach(b=>b.addEventListener('click',onBack));
  function show(screen) {
    if (!isInfoRoute(screen)) return;
    const settings = getState().readerSettings;
    document.documentElement.dataset.echoTheme = settings.theme;
    for (const [key,value] of Object.entries({'--info-font':`${settings.fontSize}px`,'--info-line':settings.lineHeight,'--info-spacing':`${settings.paragraphSpacing}em`,'--info-margin':`${settings.pageMargin}px`,'--info-width':`${settings.textWidth}px`,'--info-align':settings.alignment})) root.style.setProperty(key,value);
    pages.forEach(p=>p.hidden = p.dataset.infoPage !== screen);
    root.hidden = false; root.inert = false; root.setAttribute('aria-hidden','false');
    if(active!==screen) scroll.scrollTop=0;
    active=screen;
    current.hidden = !getState().currentChapterNumber;
    update();
    root.querySelector(`#info-${screen}-title`)?.focus({preventScroll:true});
  }
  function hide(){root.inert=true;root.setAttribute('aria-hidden','true');root.hidden=true;active=null;}
  update();
  return {show,hide};
}
