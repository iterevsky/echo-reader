import {
  DEFAULT_READER_SETTINGS,
  getState,
  updateState,
  updateReaderSettings,
  resetReaderSettings,
  markChapterRead
} from '../core/storage.js';

import { assignParagraphIds, locateParagraph, migrateLegacyAnchor, resolveReadingOffset } from '../core/anchors.js';
import { loadArtwork } from '../core/artwork.js';

const CONTROL_HIDE_DELAY = 3800;
const SAVE_DELAY = 280;
const SWIPE_THRESHOLD = 78;
const TRANSITION_DELAY = 430;

export function createReaderScreen(root, { onBack, onCurrentChapterChanged, onSettingsOpen, onSettingsClose }) {
  const scrollArea = root.querySelector('#reader-scroll');
  const numberHeading = root.querySelector('#reader-chapter-number');
  const titleHeading = root.querySelector('#reader-chapter-title');
  const textContainer = root.querySelector('#reader-text');
  const backButton = root.querySelector('[data-reader-back]');
  const settingsButton = root.querySelector('[data-reader-settings]');
  const previousButton = root.querySelector('[data-reader-previous]');
  const nextButton = root.querySelector('[data-reader-next]');
  const settingsBackdrop = root.querySelector('[data-settings-backdrop]');
  const settingsCloseButtons = [...root.querySelectorAll('[data-settings-close]')];
  const settingsResetButton = root.querySelector('[data-settings-reset]');
  const transitionLayer = root.querySelector('[data-reader-transition]');
  const transitionDirection = root.querySelector('[data-transition-direction]');
  const transitionTitle = root.querySelector('[data-transition-title]');
  const settingInputs = [...root.querySelectorAll('[data-setting]')];
  const alignmentButtons = [...root.querySelectorAll('[data-alignment]')];

  let chapters = [];
  let currentIndex = -1;
  let currentChapter = null;
  let saveTimer = null;
  let controlsTimer = null;
  let transitionTimer = null;
  let chapterRequest = 0;
  let settingsOpen = false;
  let previousFocusedElement = null;
  let lastKnownAnchor = null;
  let resizeTimer = null;
  let touchStart = null;
  let isNavigating = false;
  let restoringPosition = false;
  let moveGeneration = 0;

  function getParagraphs() {
    return [...textContainer.querySelectorAll('p')];
  }

  function getTextNodes(element) {
    const nodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;

    while ((node = walker.nextNode())) {
      nodes.push(node);
    }

    return nodes;
  }

  function getTextOffset(paragraph, targetNode, targetOffset) {
    const nodes = getTextNodes(paragraph);
    let total = 0;

    for (const node of nodes) {
      if (node === targetNode) {
        return total + targetOffset;
      }
      total += node.textContent.length;
    }

    return null;
  }

  function getCaretPosition(x, y) {
    if (typeof document.caretPositionFromPoint === 'function') {
      const position = document.caretPositionFromPoint(x, y);
      if (position) {
        return { node: position.offsetNode, offset: position.offset };
      }
    }

    if (typeof document.caretRangeFromPoint === 'function') {
      const range = document.caretRangeFromPoint(x, y);
      if (range) {
        return { node: range.startContainer, offset: range.startOffset };
      }
    }

    return null;
  }

  function captureReadingAnchor() {
    if (!currentChapter || !textContainer.children.length) return null;

    const paragraphs = getParagraphs();
    if (!paragraphs.length) return null;
    if (scrollArea.scrollTop <= 1) return { version: 2, atStart: true,
      paragraphIndex: 0, paragraphId: paragraphs[0].getAttribute('data-echo-anchor'),
      textOffset: 0, paragraphRatio: 0, viewportOffset: 24 };

    const viewport = scrollArea.getBoundingClientRect();
    const targetY = viewport.top + 24;
    let paragraphIndex = paragraphs.findIndex((paragraph) => {
      return paragraph.getBoundingClientRect().bottom > targetY;
    });

    const isInTrailingSpace = paragraphIndex < 0;
    if (isInTrailingSpace) paragraphIndex = paragraphs.length - 1;

    const paragraph = paragraphs[paragraphIndex];
    const rect = paragraph.getBoundingClientRect();
    const pointY = isInTrailingSpace
      ? rect.bottom - 1
      : Math.max(rect.top + 1, Math.min(targetY, rect.bottom - 1));
    const pointX = Math.min(rect.right - 2, rect.left + 3);
    const caret = isInTrailingSpace ? null : getCaretPosition(pointX, pointY);

    let textOffset = null;
    let viewportOffset = isInTrailingSpace
      ? rect.bottom - viewport.top
      : pointY - viewport.top;

    if (isInTrailingSpace) {
      textOffset = paragraph.textContent.length;
    }

    if (caret && paragraph.contains(caret.node) && caret.node.nodeType === Node.TEXT_NODE) {
      textOffset = getTextOffset(paragraph, caret.node, caret.offset);

      try {
        const range = document.createRange();
        range.setStart(caret.node, caret.offset);
        range.collapse(true);
        const caretRect = range.getBoundingClientRect();
        if (caretRect.height > 0) viewportOffset = caretRect.top - viewport.top;
      } catch {
        // The paragraph fallback below remains available.
      }
    }

    const paragraphRatio = rect.height > 0
      ? Math.max(0, Math.min(1, (pointY - rect.top) / rect.height))
      : 0;

    return {
      version: 2,
      paragraphId: paragraph.getAttribute('data-echo-anchor'),
      quote: Number.isInteger(textOffset) ? paragraph.textContent.slice(Math.max(0, textOffset - 20), textOffset + 80) : null,
      quoteOffset: Number.isInteger(textOffset) ? Math.min(20, textOffset) : null,
      paragraphIndex,
      textOffset,
      paragraphRatio,
      viewportOffset
    };
  }

  function restoreReadingAnchor(anchor) {
    if (!anchor) return false;

    const paragraphs = getParagraphs();
    if (anchor.atStart) { scrollArea.scrollTop = 0; return true; }
    const paragraph = locateParagraph(paragraphs, anchor);
    if (!paragraph) return false;

    const viewport = scrollArea.getBoundingClientRect();
    let targetTop = null;

    if (Number.isInteger(anchor.textOffset)) {
      const nodes = getTextNodes(paragraph);
      let remaining = resolveReadingOffset(paragraph.textContent, anchor);

      for (const node of nodes) {
        const length = node.textContent.length;
        if (remaining <= length) {
          try {
            const range = document.createRange();
            range.setStart(node, Math.min(remaining, length));
            range.collapse(true);
            const rect = range.getBoundingClientRect();
            if (rect.height > 0) {
              targetTop = rect.top - viewport.top - anchor.viewportOffset;
            }
          } catch {
            targetTop = null;
          }
          break;
        }
        remaining -= length;
      }
    }

    if (targetTop === null) {
      const rect = paragraph.getBoundingClientRect();
      const fallbackY = rect.top + rect.height * anchor.paragraphRatio;
      targetTop = fallbackY - viewport.top - anchor.viewportOffset;
    }

    scrollArea.scrollTop = Math.max(0, scrollArea.scrollTop + targetTop);
    return true;
  }

  function savePosition() {
    if (!currentChapter || restoringPosition || !root.classList.contains('is-active')) return;

    const anchor = captureReadingAnchor() || lastKnownAnchor;
    if (anchor) lastKnownAnchor = anchor;

    updateState({
      currentChapterId: currentChapter.id,
      currentChapterNumber: currentChapter.number,
      lastScrollTop: scrollArea.scrollTop,
      readingAnchor: anchor
    });
  }

  function markReadAtEnd() {
    if (!currentChapter || restoringPosition || !root.classList.contains('is-active')) return;

    const last = textContainer.lastElementChild;
    const reachedEnd = last && last.getBoundingClientRect().bottom <= scrollArea.getBoundingClientRect().bottom + 18;
    if (reachedEnd) {
      markChapterRead(currentChapter.id);
      onCurrentChapterChanged?.(currentChapter);
    }
  }

  function updateNavigationButtons() {
    previousButton.disabled = currentIndex <= 0;
    nextButton.disabled = currentIndex < 0 || currentIndex >= chapters.length - 1;
  }

  function applyReaderSettings(settings) {
    root.style.setProperty('--reader-font-size', `${settings.fontSize}px`);
    root.style.setProperty('--reader-line-height', String(settings.lineHeight));
    root.style.setProperty('--reader-paragraph-spacing', `${settings.paragraphSpacing}em`);
    root.style.setProperty('--reader-page-margin', `${settings.pageMargin}px`);
    root.style.setProperty('--reader-text-width', `${settings.textWidth}px`);
    root.style.setProperty('--reader-text-align', settings.alignment);

    settingInputs.forEach((input) => {
      const key = input.dataset.setting;
      if (!(key in settings)) return;
      input.value = String(settings[key]);
      const output = root.querySelector(`[data-setting-value="${key}"]`);
      if (output) {
        output.value = formatSettingValue(key, settings[key]);
        output.textContent = formatSettingValue(key, settings[key]);
      }
    });

    alignmentButtons.forEach((button) => {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.alignment === settings.alignment)
      );
    });
  }

  function formatSettingValue(key, value) {
    if (key === 'lineHeight' || key === 'paragraphSpacing') {
      return Number(value).toFixed(2).replace('.', ',');
    }
    return String(Math.round(Number(value)));
  }

  function showControls() {
    if (settingsOpen) return;

    root.classList.add('controls-visible');

    if (controlsTimer !== null) window.clearTimeout(controlsTimer);
    controlsTimer = window.setTimeout(() => {
      root.classList.remove('controls-visible');
      controlsTimer = null;
    }, CONTROL_HIDE_DELAY);
  }

  function hideControls() {
    root.classList.remove('controls-visible');
    if (controlsTimer !== null) {
      window.clearTimeout(controlsTimer);
      controlsTimer = null;
    }
  }

  function openSettings() {
    if (settingsOpen) return;

    savePosition();
    settingsOpen = true;
    root.classList.add('settings-preview');
    previousFocusedElement = document.activeElement;
    hideControls();
    settingsBackdrop.classList.add('is-open');
    settingsBackdrop.setAttribute('aria-hidden', 'false');
    applyReaderSettings(getState().readerSettings);

    const firstInput = settingInputs[0];
    firstInput?.focus({ preventScroll: true });
  }

  function closeSettings() {
    if (!settingsOpen) return;

    settingsOpen = false;
    root.classList.remove('settings-preview');
    settingsBackdrop.classList.remove('is-open');
    settingsBackdrop.setAttribute('aria-hidden', 'true');
    savePosition();

    if (previousFocusedElement instanceof HTMLElement) {
      previousFocusedElement.focus({ preventScroll: true });
    }
    previousFocusedElement = null;
  }

  function setChapters(items) {
    chapters = Array.isArray(items) ? items : [];
    updateNavigationButtons();
  }

  async function openChapter(chapter, { restorePosition = true } = {}) {
    const index = chapters.findIndex((item) => item.id === chapter.id);
    if (index < 0) {
      throw new Error('Выбранная глава отсутствует в каталоге.');
    }

    // Сначала надёжно фиксируем предыдущую главу, но не меняем текущую,
    // пока новый файл не загружен и не прошёл проверку структуры.
    if (currentChapter) savePosition();

    const previousState = getState();
    const isSameChapter = previousState.currentChapterId === chapter.id;
    const mayRestore = restorePosition && isSameChapter;
    const targetPosition = mayRestore ? previousState.lastScrollTop : 0;
    let targetAnchor = mayRestore ? previousState.readingAnchor : null;
    const requestId = ++chapterRequest;

    let response;
    try {
      response = await fetch(chapter.file, { cache: 'no-store' });
    } catch (error) {
      throw new Error(`Не удалось получить главу ${chapter.number}: ${error.message}`);
    }

    if (!response.ok) {
      throw new Error(`Не удалось загрузить главу ${chapter.number} (HTTP ${response.status}).`);
    }

    const html = await response.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const sourceArticle = parsed.querySelector('article.chapter-content');

    if (!sourceArticle) {
      throw new Error(`В файле главы ${chapter.number} не найден текстовый блок.`);
    }

    if (requestId !== chapterRequest) return false;

    const sourceId = sourceArticle.getAttribute('data-chapter-id');
    if (sourceId && sourceId !== chapter.id) throw new Error('Файл не соответствует выбранной главе.');
    const firstText = sourceArticle.querySelector(':scope > p')?.textContent || '';
    targetAnchor = targetPosition <= 1 ? null : migrateLegacyAnchor(targetAnchor, firstText, chapter.title);
    const paragraphs = assignParagraphIds(sourceArticle);
    if (!paragraphs.length) throw new Error('В главе отсутствует текст.');
    // Optional metadata must never delay or prevent normal reading.
    if (chapter.artwork) {
      const ids = new Set(paragraphs.map(p => p.getAttribute('data-echo-anchor')));
      loadArtwork(chapter, ids).catch(error => console.warn('ЭХО: художественная разметка недоступна.', error));
    }

    const safeNodes = [...sourceArticle.childNodes]
      .filter((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return node.nodeType === Node.TEXT_NODE;
        return !['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.tagName);
      })
      .map((node) => document.importNode(node, true));

    // Commit only after successful fetch + parse. A broken target chapter
    // must never replace the last known-good chapter or its saved position.
    restoringPosition = true;
    if (saveTimer !== null) { window.clearTimeout(saveTimer); saveTimer = null; }
    currentIndex = index;
    currentChapter = chapter;
    lastKnownAnchor = targetAnchor;
    updateNavigationButtons();
    numberHeading.textContent = `Глава ${chapter.number}`;
    titleHeading.textContent = '';
    titleHeading.hidden = true;
    textContainer.replaceChildren(...safeNodes);

    updateState({
      currentChapterId: chapter.id,
      currentChapterNumber: chapter.number,
      lastScrollTop: targetPosition,
      readingAnchor: targetAnchor
    });
    onCurrentChapterChanged?.(chapter);

    root.inert = false;
    root.setAttribute('aria-hidden', 'false');
    root.classList.add('is-active');

    await new Promise(resolve => requestAnimationFrame(resolve));
    if (requestId !== chapterRequest) return false;
    scrollArea.scrollTop = 0;
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (requestId !== chapterRequest) return false;
    {
        if (targetAnchor) {
          const restored = restoreReadingAnchor(targetAnchor);
          if (!restored) scrollArea.scrollTop = targetPosition;
        } else {
          scrollArea.scrollTop = targetPosition;
        }

        lastKnownAnchor = captureReadingAnchor();
        restoringPosition = false;
        savePosition();
        showControls();
        markReadAtEnd();
    }
    return true;
  }

  function show() {
    root.inert = false;
    root.setAttribute('aria-hidden', 'false');
    root.classList.add('is-active');
    showControls();
  }

  function hide() {
    savePosition();
    closeSettings();
    cancelPending();
    root.classList.remove('is-active', 'controls-visible');
    root.setAttribute('aria-hidden', 'true');
    root.inert = true;
    hideControls();
  }

  function cancelPending() {
    ++chapterRequest;
    ++moveGeneration;
    restoringPosition = false;
    isNavigating = false;
    if (saveTimer !== null) { window.clearTimeout(saveTimer); saveTimer = null; }
    if (resizeTimer !== null) { window.clearTimeout(resizeTimer); resizeTimer = null; }
    transitionLayer.classList.remove('is-visible');
    transitionLayer.setAttribute('aria-hidden', 'true');
    updateNavigationButtons();
  }

  async function moveTo(index, direction) {
    if (isNavigating || index < 0 || index >= chapters.length || index === currentIndex) return;
    const target = chapters[index];
    const generation = ++moveGeneration;
    isNavigating = true;
    previousButton.disabled = true;
    nextButton.disabled = true;

    savePosition();
    transitionDirection.textContent = direction === 'next' ? 'Следующая глава' : 'Предыдущая глава';
    transitionTitle.textContent = `Глава ${target.number}`;
    transitionLayer.classList.add('is-visible');
    transitionLayer.setAttribute('aria-hidden', 'false');

    // Each pending move owns its timer; cancellation is handled by its generation.
    await new Promise((resolve) => {
      transitionTimer = window.setTimeout(resolve, TRANSITION_DELAY);
    });
    transitionTimer = null;
    if (generation !== moveGeneration || !root.classList.contains('is-active')) return;

    try {
      const opened = await openChapter(target, { restorePosition: false });
      if (!opened || generation !== moveGeneration) return;
      requestAnimationFrame(() => {
        if (generation !== moveGeneration) return;
        transitionLayer.classList.remove('is-visible');
        window.setTimeout(() => {
          if (generation === moveGeneration) transitionLayer.setAttribute('aria-hidden', 'true');
        }, 420);
      });
    } catch (error) {
      if (generation !== moveGeneration) return;
      // Failed navigation must leave the previous, already saved chapter intact.
      transitionDirection.textContent = 'Не удалось перейти';
      transitionTitle.textContent = 'Остаёмся в текущей главе';
      console.error('ЭХО: ошибка перехода между главами.', error);
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      if (generation !== moveGeneration) return;
      transitionLayer.classList.remove('is-visible');
      transitionLayer.setAttribute('aria-hidden', 'true');
    } finally {
      if (generation === moveGeneration) { isNavigating = false; updateNavigationButtons(); }
    }
  }

  function applyLiveSettings(update) {
    const atTop = scrollArea.scrollTop <= 1;
    const anchor = captureReadingAnchor() || lastKnownAnchor;
    const updated = update();
    applyReaderSettings(updated.readerSettings);
    // Restore synchronously after the new layout is calculated, so rapid input
    // events cannot queue stale reading positions or visibly jump the text.
    if (atTop) scrollArea.scrollTop = 0;
    else if (anchor) restoreReadingAnchor(anchor);
    lastKnownAnchor = captureReadingAnchor() || anchor;
    savePosition();
  }

  function handleSettingChange(input) {
    const key = input.dataset.setting;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    applyLiveSettings(() => updateReaderSettings({ [key]: value }));
  }

  backButton.addEventListener('click', () => {
    savePosition();
    onBack?.();
  });

  settingsButton.addEventListener('click', () => { if (!settingsOpen) onSettingsOpen?.(); });
  previousButton.addEventListener('click', () => moveTo(currentIndex - 1, 'previous'));
  nextButton.addEventListener('click', () => moveTo(currentIndex + 1, 'next'));

  settingsCloseButtons.forEach((button) => button.addEventListener('click', () => onSettingsClose?.()));

  settingsBackdrop.addEventListener('click', (event) => {
    if (event.target === settingsBackdrop) onSettingsClose?.();
  });

  settingsResetButton.addEventListener('click', () => {
    applyLiveSettings(resetReaderSettings);
  });

  settingInputs.forEach((input) => {
    input.addEventListener('input', () => handleSettingChange(input));
  });

  alignmentButtons.forEach((button) => {
    button.addEventListener('click', () => {
      applyLiveSettings(() => updateReaderSettings({ alignment: button.dataset.alignment }));
    });
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && settingsOpen) {
      onSettingsClose?.();
    }
  });

  scrollArea.addEventListener('scroll', () => {
    if (restoringPosition || !root.classList.contains('is-active')) return;
    if (!settingsOpen && root.classList.contains('controls-visible')) hideControls();
    if (saveTimer !== null) window.clearTimeout(saveTimer);

    saveTimer = window.setTimeout(() => {
      lastKnownAnchor = captureReadingAnchor() || lastKnownAnchor;
      savePosition();
      markReadAtEnd();
      saveTimer = null;
    }, SAVE_DELAY);
  }, { passive: true });

  scrollArea.addEventListener('click', (event) => {
    if (settingsOpen || event.target.closest('button, a')) return;

    if (root.classList.contains('controls-visible')) {
      hideControls();
    } else {
      showControls();
    }
  });

  scrollArea.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1 || settingsOpen) {
      touchStart = null;
      return;
    }

    const atTop = scrollArea.scrollTop <= 8;
    const atBottom = scrollArea.scrollTop + scrollArea.clientHeight >= scrollArea.scrollHeight - 28;

    touchStart = {
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      atTop,
      atBottom
    };
  }, { passive: true });

  scrollArea.addEventListener('touchend', (event) => {
    if (!touchStart || !event.changedTouches.length) return;

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = touch.clientY - touchStart.y;
    const start = touchStart;
    touchStart = null;

    if (Math.abs(deltaY) < SWIPE_THRESHOLD || Math.abs(deltaY) < Math.abs(deltaX) * 1.25) return;

    if (deltaY < 0 && start.atBottom) {
      moveTo(currentIndex + 1, 'next');
    } else if (deltaY > 0 && start.atTop) {
      moveTo(currentIndex - 1, 'previous');
    }
  }, { passive: true });

  scrollArea.addEventListener('touchcancel', () => {
    touchStart = null;
  }, { passive: true });

  window.addEventListener('resize', () => {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    const anchor = lastKnownAnchor;

    resizeTimer = window.setTimeout(() => {
      if (anchor && currentChapter && !restoringPosition && root.classList.contains('is-active')) {
        restoreReadingAnchor(anchor);
        lastKnownAnchor = captureReadingAnchor() || anchor;
        savePosition();
      }
      resizeTimer = null;
    }, 100);
  }, { passive: true });

  window.addEventListener('pagehide', savePosition);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePosition();
  });
  window.setInterval(() => {
    if (currentChapter && root.classList.contains('is-active')) savePosition();
  }, 15000);

  applyReaderSettings(getState().readerSettings || DEFAULT_READER_SETTINGS);

  return {
    setChapters,
    openChapter,
    show,
    hide,
    cancelPending,
    openSettings,
    closeSettings,
    getCurrentChapter: () => currentChapter
  };
}
