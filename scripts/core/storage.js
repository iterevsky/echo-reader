const STORAGE_KEY = 'echo-reader-state-v1';
const BACKUP_KEY = 'echo-reader-state-v1-backup';
// Current session remains usable if persistent storage is denied or full.
let volatileState = null;

export const DEFAULT_READER_SETTINGS = Object.freeze({
  fontSize: 19,
  lineHeight: 1.72,
  paragraphSpacing: 1.08,
  pageMargin: 26,
  textWidth: 690,
  alignment: 'left',
  readingMode: 'scroll',
  pageAnimation: 'slide'
});

const DEFAULT_STATE = {
  density: 'normal',
  contentsScrollTop: 0,
  currentChapterId: null,
  currentChapterNumber: null,
  lastScrollTop: 0,
  readingAnchor: null,
  readerSettings: { ...DEFAULT_READER_SETTINGS },
  readChapterIds: []
};

const VALID_DENSITIES = new Set(['compact', 'normal', 'spacious']);
const VALID_ALIGNMENTS = new Set(['left', 'justify']);

function clamp(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function normalizeReaderSettings(value) {
  const source = value && typeof value === 'object' ? value : {};

  return {
    fontSize: clamp(source.fontSize, 16, 30, DEFAULT_READER_SETTINGS.fontSize),
    lineHeight: clamp(source.lineHeight, 1.4, 2.2, DEFAULT_READER_SETTINGS.lineHeight),
    paragraphSpacing: clamp(source.paragraphSpacing, 0.5, 1.8, DEFAULT_READER_SETTINGS.paragraphSpacing),
    pageMargin: clamp(source.pageMargin, 14, 56, DEFAULT_READER_SETTINGS.pageMargin),
    textWidth: clamp(source.textWidth, 520, 900, DEFAULT_READER_SETTINGS.textWidth),
    readingMode: source.readingMode === 'pages' ? 'pages' : 'scroll',
    pageAnimation: ['slide', 'fade', 'none'].includes(source.pageAnimation) ? source.pageAnimation : 'slide',
    alignment: VALID_ALIGNMENTS.has(source.alignment)
      ? source.alignment
      : DEFAULT_READER_SETTINGS.alignment
  };
}

function normalizeAnchor(value) {
  if (!value || typeof value !== 'object') return null;

  const paragraphIndex = Number.isInteger(value.paragraphIndex) && value.paragraphIndex >= 0
    ? value.paragraphIndex
    : null;
  const textOffset = Number.isInteger(value.textOffset) && value.textOffset >= 0
    ? value.textOffset
    : null;

  if (paragraphIndex === null) return null;

  return {
    version: value.version === 2 ? 2 : 1,
    paragraphId: typeof value.paragraphId === 'string' ? value.paragraphId.slice(0, 200) : null,
    quote: typeof value.quote === 'string' ? value.quote.slice(0, 160) : null,
    quoteOffset: Number.isInteger(value.quoteOffset) && value.quoteOffset >= 0 ? Math.min(value.quoteOffset, 160) : null,
    atStart: value.atStart === true,
    paragraphIndex,
    textOffset,
    paragraphRatio: clamp(value.paragraphRatio, 0, 1, 0),
    viewportOffset: clamp(value.viewportOffset, -200, 2000, 24)
  };
}

function normalizeState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const readIds = Array.isArray(source.readChapterIds)
    ? [...new Set(source.readChapterIds.filter((id) => typeof id === 'string'))]
    : [];

  return {
    density: VALID_DENSITIES.has(source.density) ? source.density : DEFAULT_STATE.density,
    contentsScrollTop: Number.isFinite(source.contentsScrollTop)
      ? Math.max(0, source.contentsScrollTop)
      : 0,
    currentChapterId: typeof source.currentChapterId === 'string'
      ? source.currentChapterId
      : null,
    currentChapterNumber: Number.isInteger(source.currentChapterNumber)
      ? source.currentChapterNumber
      : null,
    lastScrollTop: Number.isFinite(source.lastScrollTop)
      ? Math.max(0, source.lastScrollTop)
      : 0,
    readingAnchor: normalizeAnchor(source.readingAnchor),
    readerSettings: normalizeReaderSettings(source.readerSettings),
    readChapterIds: readIds
  };
}

function parseStoredValue(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalizeState(parsed);
  } catch {
    return null;
  }
}

export function getState() {
  if (volatileState) return normalizeState(volatileState);
  try {
    const rawPrimary = localStorage.getItem(STORAGE_KEY);
    const primary = parseStoredValue(rawPrimary);
    if (primary) return primary;

    const rawBackup = localStorage.getItem(BACKUP_KEY);
    const backup = parseStoredValue(rawBackup);
    if (backup) {
      // Restore the last confirmed good snapshot after a damaged or interrupted write.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(backup));
      } catch (error) {
        console.warn('ЭХО: резервная копия прочитана, но основную запись восстановить не удалось.', error);
      }
      return backup;
    }

    return {
      ...DEFAULT_STATE,
      readerSettings: { ...DEFAULT_READER_SETTINGS },
      readChapterIds: []
    };
  } catch {
    return {
      ...DEFAULT_STATE,
      readerSettings: { ...DEFAULT_READER_SETTINGS },
      readChapterIds: []
    };
  }
}

export function updateState(patch) {
  const current = getState();
  const next = normalizeState({ ...current, ...patch });

  try {
    const oldValue = localStorage.getItem(STORAGE_KEY);
    if (oldValue && parseStoredValue(oldValue)) {
      try { localStorage.setItem(BACKUP_KEY, oldValue); }
      catch (error) { console.warn('ЭХО: резервная копия не сохранена.', error); }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    volatileState = null;
  } catch (error) {
    volatileState = next;
    console.warn('ЭХО: состояние сохранено только до закрытия приложения.', error);
  }

  return next;
}

export function updateReaderSettings(patch) {
  const current = getState();
  return updateState({
    readerSettings: normalizeReaderSettings({
      ...current.readerSettings,
      ...patch
    })
  });
}

export function resetReaderSettings() {
  return updateState({ readerSettings: { ...DEFAULT_READER_SETTINGS } });
}

export function markChapterRead(chapterId) {
  if (typeof chapterId !== 'string' || !chapterId) return getState();
  const state = getState();
  if (state.readChapterIds.includes(chapterId)) return state;

  return updateState({
    readChapterIds: [...state.readChapterIds, chapterId]
  });
}

// Separate from resetReaderSettings: never remove reader preferences.
export function resetProgress() {
  return updateState({ currentChapterId: null, currentChapterNumber: null,
    lastScrollTop: 0, readingAnchor: null, readChapterIds: [], contentsScrollTop: 0 });
}
