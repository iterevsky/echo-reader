// One history entry per UI level; page/chapter changes replace the reader entry.
const KEY = 'echoNavigation';
const SCREENS = new Set(['splash', 'contents', 'reader', 'settings', 'contents-settings', 'about', 'author', 'feedback']);

export function parseRoute(value) {
  const route = value?.[KEY];
  if (!route || route.version !== 1 || !SCREENS.has(route.screen)) return null;
  if (['reader', 'settings'].includes(route.screen) &&
      (typeof route.chapterId !== 'string' || !route.chapterId)) return null;
  return { screen: route.screen, chapterId: route.chapterId || null };
}

export function createNavigation(onPop, host = window) {
  const history = host.history;
  const write = (method, screen, chapterId = null) => {
    const value = { ...history.state, [KEY]: { version: 1, screen, chapterId } };
    if (!parseRoute(value)) throw new Error('Invalid ECHO route');
    history[method](value, '');
  };
  const initial = parseRoute(history.state);
  if (!initial) write('replaceState', 'splash');
  const listener = event => onPop(parseRoute(event.state) || { screen: 'splash', chapterId: null });
  host.addEventListener('popstate', listener);
  return {
    initial,
    current: () => parseRoute(history.state),
    push: (screen, chapterId) => write('pushState', screen, chapterId),
    replace: (screen, chapterId) => write('replaceState', screen, chapterId),
    back: () => history.back(),
    destroy: () => host.removeEventListener('popstate', listener)
  };
}
