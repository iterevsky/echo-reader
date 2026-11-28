import { getState, resetProgress } from './storage.js';
import { createNavigation } from './navigation.js';
import { activatePendingContentVersion, registerServiceWorker, startOfflineManager, editionDownloadInfo, prefetchEditionChapter } from './offline.js';
import { createContentsScreen } from '../screens/contents.js';
import { createInfoScreen, isInfoRoute } from '../screens/info.js';
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
  let navigationEpoch = 0;
  const navigation = createNavigation(route => { renderRoute(route).catch(showNavigationError); });
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
  let resettingProgress=false;
  let infoOpen = false;
  let infoReturnScroll = null;
  let infoTrigger = null;
  const info = createInfoScreen(document.querySelector('#info-screen'), { onBack: () => navigation.back() });
  contentsRoot.querySelectorAll('[data-info-open]').forEach(button => button.addEventListener('click', () => {
    if (openingChapter || navigation.current()?.screen !== 'contents') return;
    infoReturnScroll = contentsRoot.querySelector('#contents-scroll').scrollTop;
    infoTrigger = button;
    contentsRoot.querySelector('[data-edition-menu]')?.removeAttribute('open');
    navigation.push(button.dataset.infoOpen);
    renderRoute({ screen: button.dataset.infoOpen }).catch(showNavigationError);
  }));

  function showNavigationError(error) {
    console.error('ЭХО: ошибка навигации.', error);
    window.alert('Не удалось открыть книгу. ' + error.message);
  }

  const contents = createContentsScreen(contentsRoot, async chapter => {
    if (openingChapter || navigation.current()?.screen !== 'contents') return;
    const epoch = ++navigationEpoch;
    openingChapter = true;
    try {
      const opened = await reader.openChapter(chapter, { restorePosition: true });
      if (!opened || epoch !== navigationEpoch) return;
      navigation.push('reader', chapter.id);
      contents.hide();
      reader.show();
      phase = 'reading';
    } catch (error) {
      if (epoch === navigationEpoch) { reader.hide(); contents.show(); showNavigationError(error); }
    } finally {
      if (epoch === navigationEpoch) { openingChapter = false; applyShellUpdateIfSafe(); }
    }
  });

  reader = createReaderScreen(readerRoot, {
    onBack: () => navigation.back(),
    onSettingsOpen: () => {
      const chapter = reader.getCurrentChapter();
      if (chapter && navigation.current()?.screen === 'reader') {
        navigation.push('settings', chapter.id);
        reader.openSettings();
      }
    },
    onSettingsClose: () => {
      if (navigation.current()?.screen === 'settings') navigation.back();
      else reader.closeSettings();
    },
    onResetProgress: () => {
      reader.discardProgress();resetProgress();contents.refreshState();
      resettingProgress=true;navigation.back();
    },
    onCheckDownloads: async () => {
      const chapters=await ensureCatalog();
      await Promise.all([checkShellUpdate(true),startOfflineManager(chapters,offlineStatus)]);
    },
    onFullDownload: async () => startOfflineManager(await ensureCatalog(),offlineStatus,{full:true}),
    onDownloadInfo: editionDownloadInfo,
    onCurrentChapterChanged: chapter => {
      if(chapter)prefetchEditionChapter(chapter.id);
      contents.refreshState();
      if (navigation.current()?.screen === 'reader' && chapter) navigation.replace('reader', chapter.id);
    }
  });

  function hideSplashImmediately() {
    clearTimers();
    splash.hidden = true;
    splash.inert = true;
  }

  function returnToSplash() {
    info.hide(); infoOpen = false;
    reader.hide();
    contents.hide();
    clearTimers();
    splash.hidden = false;
    splash.inert = false;
    splash.dataset.phase = 'waiting';
    splash.dataset.idle = '0';
    splash.querySelector('.splash__tap-hint')?.removeAttribute('hidden');
    title.setAttribute('aria-hidden', 'true');
    tapButton.disabled = false;
    tapButton.setAttribute('aria-label', 'Показать название книги');
    phase = 'waiting';
  }

  async function renderRoute(route) {
    const epoch = ++navigationEpoch;
    openingChapter = false;
    if(resettingProgress){
      if(route.screen==='reader'){navigation.back();return;}
      resettingProgress=false;
      if(route.screen!=='contents'){navigation.replace('contents');route={screen:'contents'};}
    }
    const returningFromInfo = infoOpen;
    if (isInfoRoute(route.screen)) {
      reader.hide(); contents.hide(); hideSplashImmediately();
      infoOpen = true; info.show(route.screen); phase = 'info'; return;
    }
    info.hide(); infoOpen = false;
    if (route.screen === 'splash') { returnToSplash(); applyShellUpdateIfSafe(); return; }

    const chapter = reader.getCurrentChapter();
    if (['reader','settings'].includes(route.screen) && chapter?.id === route.chapterId &&
        readerRoot.classList.contains('is-active')) {
      if (route.screen === 'settings') reader.openSettings();
      else reader.closeSettings();
      phase = 'reading';
      return;
    }

    reader.hide();
    openingChapter = true;
    try {
      const chapters = await ensureCatalog();
      if (epoch !== navigationEpoch) return;
      hideSplashImmediately();
      if (route.screen === 'contents') {
        contents.show({ preserveScroll: returningFromInfo });
        if (returningFromInfo) {
          if (infoReturnScroll !== null) contentsRoot.querySelector('#contents-scroll').scrollTop = infoReturnScroll;
          const target = infoTrigger?.closest('details')?.querySelector('summary') || infoTrigger;
          (target || contentsRoot.querySelector('summary'))?.focus({ preventScroll: true });
        }
        phase = 'contents';
        return;
      }
      const selected = chapters.find(item => item.id === route.chapterId);
      if (!selected) throw new Error('Глава отсутствует в каталоге.');
      const opened = await reader.openChapter(selected, { restorePosition: true });
      if (!opened || epoch !== navigationEpoch) return;
      contents.hide();
      reader.show();
      phase = 'reading';
      if (route.screen === 'settings') reader.openSettings();
    } catch (error) {
      if (epoch !== navigationEpoch) return;
      reader.hide();
      navigation.replace('contents');
      hideSplashImmediately();
      contents.show();
      phase = 'contents';
      showNavigationError(error);
    } finally {
      if (epoch === navigationEpoch) { openingChapter = false; applyShellUpdateIfSafe(); }
    }
  }

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

  async function leaveSplash() {
    if (phase !== 'title-visible') return;
    const epoch = ++navigationEpoch;
    openingChapter = true;
    phase = 'preparing-destination';
    splash.querySelector('.splash__tap-hint')?.setAttribute('hidden', '');
    clearTimers();
    tapButton.disabled = true;
    try {
      const chapters = await ensureCatalog();
      if (epoch !== navigationEpoch) return;
      navigation.push('contents');
      const saved = chapters.find(chapter => chapter.id === getState().currentChapterId);
      if (saved) {
        try {
          const opened = await reader.openChapter(saved, { restorePosition: true });
          if (epoch !== navigationEpoch || !opened) return;
          navigation.push('reader', saved.id);
          contents.hide();
          reader.show();
        } catch (error) {
          if (epoch !== navigationEpoch) return;
          reader.hide();
          contents.show();
          showNavigationError(error);
        }
      } else contents.show();
      phase = 'leaving';
      splash.dataset.phase = 'leaving';
      tapButton.setAttribute('aria-label', 'Переход');
      transitionTimer = window.setTimeout(() => {
        if (epoch !== navigationEpoch) return;
        hideSplashImmediately();
        phase = readerRoot.classList.contains('is-active') ? 'reading' : 'contents';
        applyShellUpdateIfSafe();
      }, 1850);
    } catch (error) {
      if (epoch !== navigationEpoch) return;
      returnToSplash();
      showNavigationError(error);
    } finally {
      if (epoch === navigationEpoch) openingChapter = false;
    }
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

  // Restore a managed history entry without creating duplicate history entries.
  const initialRoute = navigation.initial;
  if (initialRoute && initialRoute.screen !== 'splash') {
    renderRoute(initialRoute).catch(showNavigationError);
  } else if (shellResume?.screen === 'title-visible') {
    showTitle();
  } else if (shellResume?.screen === 'contents') {
    navigation.replace('contents');
    renderRoute({ screen: 'contents' }).catch(showNavigationError);
  }
  checkShellUpdate(true);

  const splashImage = document.querySelector('.splash__image');
  splashImage?.addEventListener('error', () => {
    console.error('ЭХО: не удалось загрузить splash-original.png. Проверь путь к изображению.');
  });

  console.info('ЭХО: приложение запущено.');
})();
