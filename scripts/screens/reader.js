import {
  DEFAULT_READER_SETTINGS,
  getState,
  updateState,
  updateReaderSettings,
  resetReaderSettings,
  markChapterRead
} from '../core/storage.js';

import { assignParagraphIds, locateParagraph, migrateLegacyAnchor, resolveReadingOffset } from '../core/anchors.js';
import { createArtisticEngine, getChapterArtwork } from '../core/artistic-engine.js';
import { fetchEditionFile } from '../core/offline.js';
import { createPagination } from '../core/pagination.js';

const CONTROL_HIDE_DELAY = 3800;
const SAVE_DELAY = 280;
const SWIPE_THRESHOLD = 78;
const TRANSITION_DELAY = 430;

export function createReaderScreen(root, { onBack, onCurrentChapterChanged, onSettingsOpen, onSettingsClose, onResetProgress, onCheckDownloads, onFullDownload, onDownloadInfo }) {
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

  const modeInput = root.querySelector('[data-reading-mode]');
  const animationInput = root.querySelector('[data-page-animation]');
  const pager = createPagination(scrollArea, root.querySelector('.reader-article'), textContainer);
  const paged = () => root.dataset.readingMode === 'pages';
  let suppressClickUntil = 0;
  const artInputs=[...root.querySelectorAll('[data-art-setting]')];
  const consent=document.querySelector('[data-audio-consent]');
  let consentTimer=0;
  const resumeDialog=document.querySelector('[data-resume-cover]');
  const tabs=[...root.querySelectorAll('[data-settings-tab]')];
  const panels=[...root.querySelectorAll('[data-settings-panel]')];
  let showResumeCover=false;
  const offlineSource=document.querySelector('[data-offline-status]');
  const downloadStatus=root.querySelector('[data-download-status]');
  const checkButton=root.querySelector('[data-download-check]');
  const fullButton=root.querySelector('[data-download-all]');
  const volumeInfo=root.querySelector('[data-download-volume]');
  fullButton.addEventListener('click',async()=>{fullButton.disabled=true;try{await onFullDownload?.();syncDownloads();}catch{downloadStatus.textContent='Загрузка не завершена. Повторите позже.';}finally{fullButton.disabled=false;}});
  const syncDownloads=()=>{downloadStatus.textContent=offlineSource?.textContent?.trim()||'Состояние загрузки пока неизвестно.';};
  if(offlineSource)new MutationObserver(syncDownloads).observe(offlineSource,{childList:true,characterData:true,subtree:true,attributes:true});
  function selectTab(key){
    tabs.forEach(t=>t.setAttribute('aria-pressed',String(t.dataset.settingsTab===key)));
    panels.forEach(p=>p.hidden=p.dataset.settingsPanel!==key);
    root.querySelector('.reader-settings__body').scrollTop=0;
    syncDownloads();
    if(key==='downloads')onDownloadInfo?.().then(info=>{volumeInfo.textContent=`${info.chapters} глав · ${info.media} художественных файлов · ${(info.bytes/1024/1024).toFixed(2).replace('.',',')} МБ без оболочки приложения`;}).catch(()=>{});
  }
  tabs.forEach(t=>t.addEventListener('click',()=>selectTab(t.dataset.settingsTab)));
  checkButton.addEventListener('click',async()=>{checkButton.disabled=true;downloadStatus.textContent='Проверяем…';try{await onCheckDownloads?.();syncDownloads();}catch{downloadStatus.textContent='Проверка не удалась. Повторите позже.';}finally{checkButton.disabled=false;}});
  root.querySelector('[data-progress-reset]').addEventListener('click',()=>{if(window.confirm('Сбросить место чтения и отметки прочитанных глав? Настройки сохранятся.'))onResetProgress?.();});
  function closeResume(){if(resumeDialog?.open)resumeDialog.close();artistic.setPaused(false);maybeConsent();}
  resumeDialog?.querySelector('[data-resume-continue]').addEventListener('click',closeResume);
  resumeDialog?.addEventListener('cancel',event=>{event.preventDefault();closeResume();});

  const artistic=createArtisticEngine(root,scrollArea,root.querySelector('.reader-chapter-heading'),textContainer,mutate=>{
    if(!currentChapter||restoringPosition){mutate();return;}
    const anchor=captureReadingAnchor()||lastKnownAnchor;
    mutate();
    artistic.refreshDimensions();
    if(paged()) pager.layout(anchor); else if(anchor) restoreReadingAnchor(anchor);
    artistic.schedule();
  });

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
    if (paged()) return pager.capture();
    if (settingsOpen && lastKnownAnchor) return lastKnownAnchor;
    const artAnchor = artistic.capture(); if (artAnchor) return artAnchor;

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

    // A toolbar can obscure caretFromPoint. Resolve the line from text geometry.
    if (textOffset === null && !isInTrailingSpace) {
      let total = 0;
      for (const node of getTextNodes(paragraph)) {
        if (!node.length) continue;
        const range = document.createRange();
        const charRect = i => {
          range.setStart(node, i); range.setEnd(node, i + 1);
          return range.getBoundingClientRect();
        };
        if (charRect(node.length - 1).bottom > pointY) {
          let lo = 0, hi = node.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (charRect(mid).bottom <= pointY) lo = mid + 1; else hi = mid;
          }
          textOffset = total + lo;
          viewportOffset = charRect(lo).top - viewport.top;
          break;
        }
        total += node.length;
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
    if (paged()) { pager.layout(anchor); artistic.schedule(); return true; }
    if (anchor.artworkId && artistic.restore(anchor)) return true;

    const paragraphs = getParagraphs();
    if (anchor.atStart && !root.querySelector('.echo-art--cover')) { scrollArea.scrollTop = 0; return true; }
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
    const reachedEnd = paged() ? pager.atEnd() : last && last.getBoundingClientRect().bottom <= scrollArea.getBoundingClientRect().bottom + 18;
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
    document.documentElement.dataset.echoTheme=settings.theme;
    root.dataset.readingMode = settings.readingMode;
    root.querySelector('[data-edition-description]').textContent={author:'Текст, иллюстрации и художественные эффекты. Звук только с разрешения.',classic:'Только текст, без художественных эффектов.',custom:'Выбери, какие элементы сопровождения оставить.'}[settings.edition];
    root.querySelectorAll('[data-sound-option]').forEach(el=>el.hidden=settings.edition==='classic'||(settings.edition==='custom'&&!settings.artSound));
    root.querySelector('[data-volume-label]').textContent=`${settings.audioVolume}%`;

    modeInput.value = settings.readingMode;
    animationInput.value = settings.pageAnimation;
    for(const input of artInputs){const k=input.dataset.artSetting;if(input.type==='checkbox')input.checked=settings[k]===true;else input.value=String(settings[k]);}
    root.querySelectorAll('[data-custom-art]').forEach(el=>el.hidden=settings.edition!=='custom');
    artistic.configure(settings);
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
      if (!document.activeElement?.closest('.reader-toolbar,.reader-footer')) root.classList.remove('controls-visible');
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

    if (!lastKnownAnchor || saveTimer !== null) savePosition();
    settingsOpen = true;
    artistic.setPaused(true);
    root.classList.add('settings-preview');
    previousFocusedElement = document.activeElement;
    hideControls();
    settingsBackdrop.inert=false;
    scrollArea.inert=true;
    root.querySelector('.reader-toolbar').inert=true;
    root.querySelector('.reader-footer').inert=true;
    selectTab('appearance');
    settingsBackdrop.classList.add('is-open');
    settingsBackdrop.setAttribute('aria-hidden', 'false');
    applyReaderSettings(getState().readerSettings);

    tabs[0]?.focus({ preventScroll: true });
    requestAnimationFrame(() => { if (settingsOpen && !settingsBackdrop.contains(document.activeElement)) tabs[0]?.focus({preventScroll:true}); });
  }

  function closeSettings() {
    if (!settingsOpen) return;

    settingsOpen = false;
    artistic.setPaused(false);
    root.classList.remove('settings-preview');
    settingsBackdrop.classList.remove('is-open');
    settingsBackdrop.inert=true;
    scrollArea.inert=false;
    root.querySelector('.reader-toolbar').inert=false;
    root.querySelector('.reader-footer').inert=false;
    settingsBackdrop.setAttribute('aria-hidden', 'true');
    savePosition();

    if (previousFocusedElement instanceof HTMLElement) {
      previousFocusedElement.focus({ preventScroll: true });
    }
    previousFocusedElement = null;
    if(getState().readerSettings.audioConsent===null)maybeConsent();
  }

  function setChapters(items) {
    chapters = Array.isArray(items) ? items : [];
    updateNavigationButtons();
  }

  async function openChapter(chapter, { restorePosition = true, startAtEnd = false } = {}) {
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
      response = await fetchEditionFile(chapter.file);
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
    if (targetAnchor?.version !== 2) targetAnchor = targetPosition <= 1 ? null : migrateLegacyAnchor(targetAnchor, firstText, chapter.title);
    const paragraphs = assignParagraphIds(sourceArticle);
    if (!paragraphs.length) throw new Error('В главе отсутствует текст.');
    const metadata=await getChapterArtwork(chapter,paragraphs);
    if(requestId!==chapterRequest)return false;

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
    showResumeCover=Boolean(mayRestore && targetAnchor && !targetAnchor.atStart && targetAnchor.artworkId!=='cover' && getState().readerSettings.reopen==='cover' && getState().readerSettings.edition!=='classic' && (getState().readerSettings.edition!=='custom'||getState().readerSettings.illustrations));
    updateNavigationButtons();
    numberHeading.textContent = `Глава ${chapter.number}`;
    titleHeading.textContent = '';
    titleHeading.hidden = true;
    textContainer.replaceChildren(...safeNodes);
    artistic.setActive(false);
    artistic.setChapter(chapter,metadata,getState().readerSettings);

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
    artistic.refreshDimensions();
    scrollArea.scrollTop = 0;
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (requestId !== chapterRequest) return false;
    {
        if (paged()) {
          pager.layout(targetAnchor, startAtEnd);
        } else if (targetAnchor) {
          const restored = restoreReadingAnchor(targetAnchor);
          if (!restored) scrollArea.scrollTop = targetPosition;
        } else {
          scrollArea.scrollTop = targetPosition;
        }

        artistic.setActive(true);
        lastKnownAnchor = captureReadingAnchor();
        restoringPosition = false;
        savePosition();
        showControls();
        markReadAtEnd();
    }
    return true;
  }

  function maybeConsent(){
    clearTimeout(consentTimer);
    const prefs=getState().readerSettings;
    if(prefs.audioConsent!==null || prefs.edition==='classic' || (prefs.edition==='custom'&&!prefs.artSound) || !consent?.showModal)return;
    consentTimer=setTimeout(()=>{
      if(!root.classList.contains('is-active')||settingsOpen||consent.open||getState().readerSettings.audioConsent!==null)return;
      artistic.setPaused(true); consent.showModal();
    },2000);
  }
  function chooseAudio(value){
    applyLiveSettings(()=>updateReaderSettings({audioConsent:value}));
    consent?.close(); artistic.setPaused(false);
  }
  consent?.querySelectorAll('[data-audio-choice]').forEach(b=>b.addEventListener('click',()=>chooseAudio(b.dataset.audioChoice==='yes')));
  consent?.addEventListener('cancel',event=>{event.preventDefault();chooseAudio(false);});

  function show() {
    root.inert = false;
    root.setAttribute('aria-hidden', 'false');
    root.classList.add('is-active');
    artistic.setActive(true);
    if(showResumeCover && resumeDialog?.showModal){
      showResumeCover=false;
      const image=root.querySelector('.echo-art--cover img');
      const generation=chapterRequest, id=currentChapter.id;
      const display=()=>{if(generation!==chapterRequest||currentChapter?.id!==id||!root.classList.contains('is-active')||settingsOpen||resumeDialog.open)return;
        if(image?.naturalWidth>0){resumeDialog.querySelector('[data-resume-image]').src=image.currentSrc||image.src;resumeDialog.querySelector('[data-resume-number]').textContent=`Глава ${currentChapter.number}`;artistic.setPaused(true);resumeDialog.showModal();}else maybeConsent();};
      if(image?.complete&&image.naturalWidth>0)display();else if(image){
        // Do not open a delayed modal after the reader has started interacting.
        let done=false;const cleanup=()=>{clearTimeout(timer);image.removeEventListener('load',finish);image.removeEventListener('error',cancel);root.removeEventListener('pointerdown',cancel,true);};
        const cancel=()=>{if(done)return;done=true;cleanup();maybeConsent();};
        const finish=()=>{if(done)return;done=true;cleanup();display();};
        const timer=setTimeout(cancel,1800);image.addEventListener('load',finish);image.addEventListener('error',cancel);root.addEventListener('pointerdown',cancel,true);
      }else maybeConsent();
    }else maybeConsent();
    if (!resumeDialog?.open && !consent?.open) scrollArea.focus({preventScroll:true});
    showControls();
  }

  function hide() {
    savePosition();
    if(resumeDialog?.open)resumeDialog.close();
    showResumeCover=false;
    closeSettings();
    cancelPending();
    clearTimeout(consentTimer);if(consent?.open)consent.close();
    artistic.setActive(false);artistic.setPaused(false);
    root.classList.remove('is-active', 'controls-visible');
    root.setAttribute('aria-hidden', 'true');
    root.inert = true;
    hideControls();
  }

  function cancelPending() {
    ++chapterRequest;
    ++moveGeneration;
    pager.stop();
    restoringPosition = false;
    isNavigating = false;
    if (saveTimer !== null) { window.clearTimeout(saveTimer); saveTimer = null; }
    if (resizeTimer !== null) { window.clearTimeout(resizeTimer); resizeTimer = null; }
    transitionLayer.classList.remove('is-visible');
    transitionLayer.setAttribute('aria-hidden', 'true');
    updateNavigationButtons();
  }

  async function moveTo(index, direction, startAtEnd = false) {
    if (isNavigating || index < 0 || index >= chapters.length || index === currentIndex) return;
    const target = chapters[index];
    const generation = ++moveGeneration;
    isNavigating = true;
    artistic.setPaused(true);
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
      const opened = await openChapter(target, { restorePosition: false, startAtEnd });
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
      if (generation === moveGeneration) { isNavigating = false; artistic.setPaused(false); updateNavigationButtons(); }
    }
  }

  function applyLiveSettings(update) {
    const anchor = captureReadingAnchor() || lastKnownAnchor;
    const wasPaged = paged();
    const updated = update();
    applyReaderSettings(updated.readerSettings);
    artistic.refreshDimensions();
    if (paged()) pager.layout(anchor);
    else {
      if (wasPaged) pager.disable();
      if (anchor) restoreReadingAnchor(anchor);
      else scrollArea.scrollTop = 0;
    }
    lastKnownAnchor = captureReadingAnchor() || anchor;
    savePosition();artistic.schedule();
  }

  function turnPage(delta) {
    if (!paged() || settingsOpen || restoringPosition || isNavigating) return;
    hideControls();
    if (pager.turn(delta, getState().readerSettings.pageAnimation)) {
      savePosition();
      markReadAtEnd();
      artistic.resetIdle();artistic.schedule();setTimeout(()=>artistic.schedule(),300);
    } else {
      moveTo(currentIndex + delta, delta > 0 ? 'next' : 'previous', delta < 0);
    }
  }

  artInputs.forEach(input=>input.addEventListener('change',()=>applyLiveSettings(()=>updateReaderSettings({[input.dataset.artSetting]:input.type==='checkbox'?input.checked:input.type==='range'?Number(input.value):input.value}))));
  modeInput.addEventListener('change', () => applyLiveSettings(() => updateReaderSettings({readingMode: modeInput.value})));
  animationInput.addEventListener('change', () => applyLiveSettings(() => updateReaderSettings({pageAnimation: animationInput.value})));

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
    if(window.confirm('Вернуть настройки к значениям по умолчанию? Место чтения сохранится.'))applyLiveSettings(resetReaderSettings);
  });

  settingInputs.forEach((input) => {
    input.addEventListener('input', () => handleSettingChange(input));
  });

  alignmentButtons.forEach((button) => {
    button.addEventListener('click', () => {
      applyLiveSettings(() => updateReaderSettings({ alignment: button.dataset.alignment }));
    });
  });

  root.addEventListener('focusin', event => {
    if (!settingsOpen && event.target.closest('.reader-toolbar,.reader-footer')) showControls();
  });
  root.addEventListener('focusout', event => {
    if (!settingsOpen && event.target.closest('.reader-toolbar,.reader-footer')) showControls();
  });
  document.addEventListener('keydown', (event) => {
    if (!root.classList.contains('is-active') || consent?.open || resumeDialog?.open) return;
    if (!settingsOpen && event.target === scrollArea && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (paged() && ['ArrowLeft','ArrowRight','PageUp','PageDown'].includes(event.key)) {
        event.preventDefault(); turnPage(['ArrowRight','PageDown'].includes(event.key)?1:-1); return;
      }
      if (event.key === 'Enter') { event.preventDefault(); showControls(); return; }
    }
    if(event.key==='Tab' && settingsOpen){
      const items=[...settingsBackdrop.querySelectorAll('button,input,select')].filter(e=>!e.disabled&&e.getClientRects().length);
      if(items.length && (event.shiftKey&&document.activeElement===items[0]||!event.shiftKey&&document.activeElement===items.at(-1))){event.preventDefault();(event.shiftKey?items.at(-1):items[0]).focus();}
    }
    if (event.key === 'Escape' && settingsOpen) {
      event.preventDefault();
      onSettingsClose?.();
    }
  });

  scrollArea.addEventListener('scroll', () => {
    if (paged() || restoringPosition || !root.classList.contains('is-active')) return;
    if (!settingsOpen && root.classList.contains('controls-visible') && !document.activeElement?.closest('.reader-toolbar,.reader-footer')) hideControls();
    if (saveTimer !== null) window.clearTimeout(saveTimer);

    saveTimer = window.setTimeout(() => {
      lastKnownAnchor = captureReadingAnchor() || lastKnownAnchor;
      savePosition();
      markReadAtEnd();
      saveTimer = null;
    }, SAVE_DELAY);
  }, { passive: true });

  scrollArea.addEventListener('click', (event) => {
    if (settingsOpen || Date.now() < suppressClickUntil || event.target.closest('button, a, input, select') || window.getSelection()?.toString()) return;
    if (paged()) {
      const r = scrollArea.getBoundingClientRect();
      const x = (event.clientX - r.left) / r.width;
      if (x < .30) { turnPage(-1); return; }
      if (x > .70) { turnPage(1); return; }
    }

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

    if (paged()) {
      const r = scrollArea.getBoundingClientRect();
      // Leave system edge-back gestures to the browser and OS.
      if (start.x - r.left < 24 || r.right - start.x < 24) return;
      if (Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.25 && !window.getSelection()?.toString()) {
        suppressClickUntil = Date.now() + 350;
        turnPage(deltaX < 0 ? 1 : -1);
      }
      return;
    }

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
        artistic.refreshDimensions();
        restoreReadingAnchor(anchor);
        artistic.schedule();
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
    discardProgress: () => {hide();currentChapter=null;currentIndex=-1;lastKnownAnchor=null;updateNavigationButtons();},
    getCurrentChapter: () => currentChapter
  };
}
