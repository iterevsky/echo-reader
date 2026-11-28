import { getState, updateState } from '../core/storage.js';

import { loadEditionCatalog } from '../core/offline.js';
const RANGE_SIZE = 25;

export function createContentsScreen(root, onOpenChapter) {
  const list = root.querySelector('#chapter-list');
  const scrollArea = root.querySelector('#contents-scroll');
  const rangeNav = root.querySelector('[data-range-nav]');
  const loadingMessage = root.querySelector('[data-contents-loading]');
  const densityButtons = [...root.querySelectorAll('[data-density]')];

  let chapters = [];
  let initialized = false;
  let scrollSaveTimer = null;
  let activeRangeStart = null;

  function setDensity(density) {
    root.dataset.density = density;

    densityButtons.forEach((button) => {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.density === density)
      );
    });

    updateState({ density });
    updateRangeFromScroll();
  }

  function updateCurrentAndReadStates() {
    const state = getState();

    list.querySelectorAll('[data-chapter-id]').forEach((button) => {
      const isCurrent = button.dataset.chapterId === state.currentChapterId;
      const isRead = state.readChapterIds.includes(button.dataset.chapterId);

      button.classList.toggle('is-current', isCurrent);
      button.classList.toggle('is-read', isRead);
      const chapter=chapters.find(c=>c.id===button.dataset.chapterId);
      if(chapter)button.setAttribute('aria-label', `Глава ${chapter.number}. ${chapter.title}${isRead?', прочитана':''}`);

      if (isCurrent) {
        button.setAttribute('aria-current', 'page');
      } else {
        button.removeAttribute('aria-current');
      }
    });
  }

  function setActiveRange(start) {
    if (activeRangeStart === start) return;
    activeRangeStart = start;

    rangeNav.querySelectorAll('[data-range-start]').forEach((button) => {
      const active = Number(button.dataset.rangeStart) === start;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-current', active ? 'true' : 'false');
    });
  }

  function updateRangeFromScroll() {
    if (!chapters.length) return;

    const viewport = scrollArea.getBoundingClientRect();
    const entries = [...list.querySelectorAll('.chapter-row')];
    const firstVisible = entries.find((entry) => {
      return entry.getBoundingClientRect().bottom > viewport.top + 8;
    });

    if (!firstVisible) return;
    const number = Number(firstVisible.dataset.chapterNumber);
    const start = Math.floor((number - 1) / RANGE_SIZE) * RANGE_SIZE + 1;
    setActiveRange(start);
  }

  function buildRanges() {
    rangeNav.replaceChildren();

    for (let start = 1; start <= chapters.length; start += RANGE_SIZE) {
      const end = Math.min(start + RANGE_SIZE - 1, chapters.length);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'range-button';
      button.dataset.rangeStart = String(start);
      button.textContent = `${start}–${end}`;
      button.setAttribute('aria-label', `Главы с ${start} по ${end}`);

      button.addEventListener('click', () => {
        const target = list.querySelector(`[data-chapter-number="${start}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });

      rangeNav.append(button);
    }
  }

  function renderChapters() {
    const fragment = document.createDocumentFragment();

    chapters.forEach((chapter) => {
      const item = document.createElement('li');
      item.className = 'chapter-row';
      item.dataset.chapterNumber = String(chapter.number);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chapter-entry';
      button.dataset.chapterId = chapter.id;
      button.setAttribute('aria-label', `Глава ${chapter.number}. ${chapter.title}`);

      const number = document.createElement('span');
      number.className = 'chapter-number';
      number.textContent = String(chapter.number).padStart(2, '0');
      number.setAttribute('aria-hidden', 'true');

      const title = document.createElement('span');
      title.className = 'chapter-title';
      title.textContent = chapter.title;

      button.append(number, title);
      button.addEventListener('click', () => onOpenChapter(chapter));
      item.append(button);
      fragment.append(item);
    });

    list.replaceChildren(fragment);
    loadingMessage.hidden = true;
    buildRanges();
    updateCurrentAndReadStates();
    updateRangeFromScroll();
  }

  async function initialize() {
    if (initialized) return chapters;

    loadingMessage.hidden = false;
    loadingMessage.textContent = 'Загружаем содержание…';

    const catalog = await loadEditionCatalog();
    if (!catalog || !Array.isArray(catalog.chapters) || catalog.chapters.length === 0) {
      throw new Error('Каталог глав пуст или имеет неверный формат.');
    }

    const seenIds = new Set();
    const seenNumbers = new Set();

    chapters = catalog.chapters.map((chapter) => {
      if (
        !chapter ||
        typeof chapter.id !== 'string' ||
        !Number.isInteger(chapter.number) ||
        typeof chapter.title !== 'string' ||
        typeof chapter.file !== 'string'
      ) {
        throw new Error('В каталоге обнаружена запись главы с неверными полями.');
      }

      if (seenIds.has(chapter.id) || seenNumbers.has(chapter.number)) {
        throw new Error('В каталоге обнаружены повторяющиеся ID или номера глав.');
      }

      seenIds.add(chapter.id);
      seenNumbers.add(chapter.number);
      return chapter;
    }).sort((a, b) => a.number - b.number);

    initialized = true;

    const state = getState();
    setDensity(state.density);
    renderChapters();
    scrollArea.scrollTop = state.contentsScrollTop;
    updateRangeFromScroll();

    return chapters;
  }

  function show({ preserveScroll = false } = {}) {
    root.inert = false;
    root.setAttribute('aria-hidden', 'false');
    root.classList.add('is-active');
    updateCurrentAndReadStates();
    const id = getState().currentChapterId;
    const current = [...list.querySelectorAll('[data-chapter-id]')].find(button => button.dataset.chapterId === id);
    if (current && !preserveScroll) { current.scrollIntoView({ block: 'nearest', behavior: 'instant' }); current.focus({preventScroll:true}); }
    else if (!preserveScroll) scrollArea.focus({preventScroll:true});
    updateRangeFromScroll();
  }

  function hide() {
    root.classList.remove('is-active');
    root.setAttribute('aria-hidden', 'true');
    root.inert = true;
  }

  function refreshState() {
    updateCurrentAndReadStates();
  }

  function getChapters() {
    return chapters;
  }

  densityButtons.forEach((button) => {
    button.addEventListener('click', () => setDensity(button.dataset.density));
  });

  scrollArea.addEventListener('scroll', () => {
    updateRangeFromScroll();

    if (scrollSaveTimer !== null) {
      window.clearTimeout(scrollSaveTimer);
    }

    scrollSaveTimer = window.setTimeout(() => {
      updateState({ contentsScrollTop: scrollArea.scrollTop });
      scrollSaveTimer = null;
    }, 180);
  }, { passive: true });

  window.addEventListener('pagehide', () => {
    if (scrollSaveTimer !== null) window.clearTimeout(scrollSaveTimer);
    updateState({ contentsScrollTop: scrollArea.scrollTop });
  });

  return {
    initialize,
    show,
    hide,
    refreshState,
    getChapters
  };
}
