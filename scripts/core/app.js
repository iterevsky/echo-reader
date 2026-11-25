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
  let pendingShellBuild = null;
  let shellReloading = false;
  let openingChapter = false;
  const SHELL_BUILD = document.querySelector('meta[name="echo-build"]')?.content;
  const SHELL_RESUME_KEY = "echo-shell-resume-v1";
  const SHELL_RELOAD_KEY = "echo-shell-reload-v1";
  let shellResume = null;
  try {
    shellResume = JSON.parse(sessionStorage.getItem(SHELL_RESUME_KEY) || "null");
    sessionStorage.removeItem(SHELL_RESUME_KEY);
    if (shellResume?.build !== SHELL_BUILD || Date.now() - shellResume.time > 120000) shellResume = null;
  } catch { shellResume = null; }
  const pendingActivationPromise = activatePendingContentVersion();

  // Регистрация не блокирует заставку. Обновление UI и обновление текста независимы.
  const registrationPromise = registerServiceWorker();
  let checkInProgress = null;
  let lastUpdateCheck = 0;

  function applyShellUpdateIfSafe() {
    if (!pendingShellBuild || shellReloading || openingChapter || document.visibilityState !== 'visible') return;
    if (readerRoot.classList.contains('is-active')) return;
    const onSplash = !splash.hidden && (phase === 'waiting' || phase === 'title-visible');
    const onContents = splash.hidden && contentsRoot.classList.contains('is-active');
    if (!onSplash && !onContents) return;
    try {
      const guard = JSON.parse(sessionStorage.getItem(SHELL_RELOAD_KEY) || 'null');
      // Защита от циклической перезагрузки при рассинхронизации CDN.
      if (guard?.build === pendingShellBuild && Date.now() - guard.time < 120000) return;
      const time = Date.now();
      sessionStorage.setItem(SHELL_RELOAD_KEY, JSON.stringify({ build: pendingShellBuild, time }));
      sessionStorage.setItem(SHELL_RESUME_KEY, JSON.stringify({
        build: pendingShellBuild, time, screen: onContents ? 'contents' : phase
      }));
    } catch {
      // Если браузер запретил sessionStorage, не рискуем циклическим обновлением.
      return;
    }
    shellReloading = true;
    window.location.reload();
  }

  async function inspectController() {
    const controller = navigator.serviceWorker?.controller;
    if (!controller || !SHELL_BUILD) return;
    const build = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const finish = (value) => {
        window.clearTimeout(timer);
        channel.port1.close();
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(null), 1500);
      channel.port1.onmessage = (event) => finish(event.data?.build || null);
      try { controller.postMessage({ type: 'ECHO_GET_BUILD' }, [channel.port2]); }
      catch { finish(null); }
    });
    if (navigator.serviceWorker.controller !== controller) return;
    if (build && build !== SHELL_BUILD) pendingShellBuild = build;
    else if (build === SHELL_BUILD) pendingShellBuild = null;
    applyShellUpdateIfSafe();
  }

  function checkShellUpdate(force = false) {
    if (!('serviceWorker' in navigator) || document.visibilityState !== 'visible') return;
    // Возврат из фона проверяем сразу, частые focus-события объединяем.
    if (checkInProgress) return checkInProgress;
    if (!force && Date.now() - lastUpdateCheck < 10000) {
      return inspectController().catch(() => {});
    }
    lastUpdateCheck = Date.now();
    checkInProgress = (async () => {
      const registration = await registrationPromise;
      if (registration && navigator.onLine !== false) {
        await registration.update().catch(() => {});
      }
      await inspectController();
    })().catch(() => {}).finally(() => { checkInProgress = null; });
    return checkInProgress;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      inspectController().catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkShellUpdate(true);
    });
    window.addEventListener('pageshow', (event) => checkShellUpdate(event.persisted));
    window.addEventListener('focus', () => checkShellUpdate());
    window.addEventListener('online', () => checkShellUpdate(true));
    window.setInterval(() => checkShellUpdate(), 5 * 60 * 1000);
  }

  let reader;

  const contents = createContentsScreen(contentsRoot, async (chapter) => {
    openingChapter = true;
    try {
      contents.hide();
      await reader.openChapter(chapter, { restorePosition: true });
      reader.show();
    } catch (error) {
      contents.show();
      console.error('ЭХО: не удалось открыть главу.', error);
      window.alert(`Не удалось открыть главу ${chapter.number}.\n${error.message}`);
    } finally {
      openingChapter = false;
      applyShellUpdateIfSafe();
    }
  });

  reader = createReaderScreen(readerRoot, {
    onBack: () => {
      contents.show();
      applyShellUpdateIfSafe();
    },
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
      applyShellUpdateIfSafe();
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

  // Возвращаем экран, на котором была безопасно применена новая оболочка.
  if (shellResume?.screen === 'title-visible') {
    showTitle();
  } else if (shellResume?.screen === 'contents') {
    phase = 'preparing-destination';
    ensureCatalog().then(() => {
      contents.show();
      splash.hidden = true;
      splash.inert = true;
      phase = 'contents';
      applyShellUpdateIfSafe();
    }).catch(() => { phase = 'waiting'; });
  }
  checkShellUpdate(true);

  const splashImage = document.querySelector('.splash__image');
  splashImage?.addEventListener('error', () => {
    console.error('ЭХО: не удалось загрузить splash-original.png. Проверь путь к изображению.');
  });

  console.info('ЭХО: приложение запущено.');
})();
