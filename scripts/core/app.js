import { getState } from './storage.js';
import { activatePendingContentVersion, registerServiceWorker, startOfflineManager } from './offline.js';
import { createContentsScreen } from '../screens/contents.js';
import { createReaderScreen } from '../screens/reader.js';

(() => {
  'use strict';

  const splash = document.querySelector('[data-splash]');
  const tapButton = document.querySelector('[data-splash-action]');
  const title = document.querySelector('.splash__title');
  const contentsRoot = document.querySelector('#contents-screen');
  const readerRoot = document.querySelector('#reader-screen');
  const offlineStatus = document.querySelector('[data-offline-status]');

  if (!splash || !tapButton || !title || !contentsRoot || !readerRoot) {
    console.error('ЭХО: не удалось найти необходимые элементы приложения.');
    return;
  }

  let phase = 'waiting';
  let idleTimers = [];
  let transitionTimer = null;
  let catalogPromise = null;
  let offlineManagerStarted = false;
  const pendingActivationPromise = activatePendingContentVersion();

  // Регистрация не блокирует заставку. Первый запуск worker-кэша происходит в фоне.
  registerServiceWorker().catch((error) => {
    console.warn('ЭХО: регистрация офлайн-режима не удалась.', error);
  });

  let reader;

  const contents = createContentsScreen(contentsRoot, async (chapter) => {
    try {
      contents.hide();
      await reader.openChapter(chapter, { restorePosition: true });
      reader.show();
    } catch (error) {
      contents.show();
      console.error('ЭХО: не удалось открыть главу.', error);
      window.alert(`Не удалось открыть главу ${chapter.number}.\n${error.message}`);
    }
  });

  reader = createReaderScreen(readerRoot, {
    onBack: () => contents.show(),
    onCurrentChapterChanged: () => contents.refreshState()
  });

  async function ensureCatalog() {
    await pendingActivationPromise;

    if (!catalogPromise) {
      catalogPromise = contents.initialize()
        .then((chapters) => {
          reader.setChapters(chapters);
          if (!offlineManagerStarted) {
            offlineManagerStarted = true;
            startOfflineManager(chapters, offlineStatus).catch((error) => {
              console.warn('ЭХО: фоновая подготовка офлайн-доступа не удалась.', error);
            });
          }
          return chapters;
        })
        .catch((error) => {
          catalogPromise = null;
          throw error;
        });
    }

    return catalogPromise;
  }

  function clearTimers() {
    idleTimers.forEach(window.clearTimeout);
    idleTimers = [];

    if (transitionTimer !== null) {
      window.clearTimeout(transitionTimer);
      transitionTimer = null;
    }
  }

  function startIdleSequence() {
    const levels = [
      { delay: 4500, level: '1' },
      { delay: 8500, level: '2' },
      { delay: 12500, level: '3' }
    ];

    levels.forEach(({ delay, level }) => {
      const timer = window.setTimeout(() => {
        if (phase === 'title-visible') {
          splash.dataset.idle = level;
        }
      }, delay);

      idleTimers.push(timer);
    });
  }

  function showTitle() {
    if (phase !== 'waiting') return;

    phase = 'title-visible';
    splash.dataset.phase = 'title-visible';
    splash.dataset.idle = '0';

    title.setAttribute('aria-hidden', 'false');
    tapButton.setAttribute('aria-label', 'Перейти к следующему экрану');

    // Каталог подготавливается заранее, но не задерживает появление заставки.
    ensureCatalog().catch((error) => {
      console.error('ЭХО: не удалось подготовить каталог глав.', error);
    });

    startIdleSequence();
  }

  async function prepareDestination() {
    const chapters = await ensureCatalog();
    const state = getState();

    if (state.currentChapterId) {
      const savedChapter = chapters.find((chapter) => chapter.id === state.currentChapterId);
      if (savedChapter) {
        await reader.openChapter(savedChapter, { restorePosition: true });
        reader.show();
        return;
      }
    }

    contents.show();
  }

  async function leaveSplash() {
    if (phase !== 'title-visible') return;

    phase = 'preparing-destination';
    splash.querySelector('.splash__tap-hint')?.setAttribute('hidden', '');
    clearTimers();
    tapButton.disabled = true;

    try {
      await prepareDestination();
    } catch (error) {
      console.error('ЭХО: не удалось подготовить следующий экран.', error);
      contentsRoot.classList.add('is-active');
      contentsRoot.inert = false;
      contentsRoot.setAttribute('aria-hidden', 'false');
      contentsRoot.querySelector('[data-contents-loading]').textContent =
        'Не удалось загрузить содержание. Проверь наличие data/chapters.json и перезапусти страницу.';
    }

    phase = 'leaving';
    splash.dataset.phase = 'leaving';
    tapButton.setAttribute('aria-label', 'Переход');

    transitionTimer = window.setTimeout(() => {
      splash.hidden = true;
      splash.inert = true;
      transitionTimer = null;
      phase = readerRoot.classList.contains('is-active') ? 'reading' : 'contents';
    }, 1850);
  }

  function handleSplashTap() {
    if (phase === 'waiting') {
      showTitle();
      return;
    }

    if (phase === 'title-visible') {
      leaveSplash();
    }
  }

  tapButton.addEventListener('click', handleSplashTap);

  const splashImage = document.querySelector('.splash__image');
  splashImage?.addEventListener('error', () => {
    console.error('ЭХО: не удалось загрузить splash-original.png. Проверь путь к изображению.');
  });

  console.info('ЭХО: приложение запущено.');
})();
