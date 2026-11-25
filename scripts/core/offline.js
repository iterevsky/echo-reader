const PROJECT_ROOT = new URL('../../', import.meta.url);
const CATALOG_PATH = 'data/chapters.json';
const MANIFEST_PATH = 'data/chapters-manifest.json';
const META_CACHE = 'echo-meta-v1';
const BOOTSTRAP_CACHE = 'echo-content-bootstrap-v1';
const CONTENT_CACHE_PREFIX = 'echo-content-';
const ACTIVE_MARKER = new URL('__echo__/active-content.json', PROJECT_ROOT).href;
const PENDING_MARKER = new URL('__echo__/pending-content.json', PROJECT_ROOT).href;
const DOWNLOAD_CONCURRENCY = 2;

let managerRunning = false;
let latestRun = null;
let onlineListenerAttached = false;
let lastChapters = [];
let lastStatusNode = null;

function projectUrl(path) {
  return new URL(path, PROJECT_ROOT).href;
}

function setStatus(node, message, state = 'info') {
  if (!node) return;
  node.textContent = message;
  node.dataset.state = state;
  node.hidden = !message;
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Проверка целостности недоступна в этом браузере.');
  }
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function readJsonResponse(response, label) {
  if (!response || !response.ok) {
    throw new Error(`${label}: HTTP ${response?.status ?? 'нет ответа'}`);
  }
  const bytes = await response.arrayBuffer();
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch {
    throw new Error(`${label}: повреждён JSON.`);
  }
  return { data, bytes };
}

function validateCatalog(catalog) {
  if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.chapters) || !catalog.chapters.length) {
    throw new Error('Каталог глав имеет неизвестную или пустую структуру.');
  }

  const ids = new Set();
  const numbers = new Set();

  for (const chapter of catalog.chapters) {
    if (
      !chapter ||
      typeof chapter.id !== 'string' ||
      !Number.isInteger(chapter.number) ||
      typeof chapter.title !== 'string' ||
      typeof chapter.file !== 'string'
    ) {
      throw new Error('В каталоге обнаружена некорректная запись главы.');
    }
    if (ids.has(chapter.id) || numbers.has(chapter.number)) {
      throw new Error('В каталоге обнаружены повторяющиеся ID или номера глав.');
    }
    if (!/^data\/chapters\/[0-9]{3}\.html$/.test(chapter.file)) {
      throw new Error(`Недопустимый путь файла главы ${chapter.number}.`);
    }
    ids.add(chapter.id);
    numbers.add(chapter.number);
  }
}

async function validateSnapshot(catalogBytes, catalog, manifest) {
  validateCatalog(catalog);

  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.contentVersion !== 'string' ||
    !/^[a-f0-9]{20}$/.test(manifest.contentVersion) ||
    !Array.isArray(manifest.chapters) ||
    manifest.chapters.length !== catalog.chapters.length
  ) {
    throw new Error('Манифест контента имеет неверный формат.');
  }

  const catalogHash = await sha256(catalogBytes);
  if (catalogHash !== manifest.catalogSha256) {
    throw new Error('Контрольная сумма каталога не совпадает с манифестом.');
  }

  const manifestById = new Map();
  for (const item of manifest.chapters) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !Number.isInteger(item.number) ||
      typeof item.file !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isInteger(item.bytes) || item.bytes < 0
    ) {
      throw new Error('В манифесте обнаружена некорректная запись файла.');
    }
    if (manifestById.has(item.id)) {
      throw new Error('В манифесте обнаружен повторяющийся ID главы.');
    }
    manifestById.set(item.id, item);
  }

  for (const chapter of catalog.chapters) {
    const item = manifestById.get(chapter.id);
    if (!item || item.number !== chapter.number || item.file !== chapter.file) {
      throw new Error(`Каталог и манифест расходятся на главе ${chapter.number}.`);
    }
  }

  const totalBytes = manifest.chapters.reduce((sum, item) => sum + item.bytes, 0);
  if (manifest.totalBytes !== totalBytes) {
    throw new Error('Общий размер контента не совпадает с записями манифеста.');
  }

  const versionSource = `${manifest.catalogSha256}\n${manifest.chapters
    .map((item) => `${item.id}:${item.sha256}`)
    .join('\n')}`;
  const expectedVersion = (await sha256(new TextEncoder().encode(versionSource))).slice(0, 20);
  if (manifest.contentVersion !== expectedVersion) {
    throw new Error('Идентификатор версии контента не совпадает с контрольными суммами.');
  }
}

async function fetchSnapshot(networkOnly) {
  const headers = networkOnly ? { 'X-Echo-Network-Only': '1' } : undefined;
  const options = { cache: 'no-store' };
  if (headers) options.headers = headers;

  const [catalogResponse, manifestResponse] = await Promise.all([
    fetch(projectUrl(CATALOG_PATH), options),
    fetch(projectUrl(MANIFEST_PATH), options)
  ]);

  const catalogResult = await readJsonResponse(catalogResponse, 'Каталог глав');
  const manifestResult = await readJsonResponse(manifestResponse, 'Манифест контента');
  await validateSnapshot(catalogResult.bytes, catalogResult.data, manifestResult.data);

  return {
    catalog: catalogResult.data,
    catalogBytes: catalogResult.bytes,
    manifest: manifestResult.data,
    manifestBytes: manifestResult.bytes
  };
}

async function readSnapshotFromCache(cache) {
  if (!cache) return null;
  const [catalogResponse, manifestResponse] = await Promise.all([
    cache.match(projectUrl(CATALOG_PATH)),
    cache.match(projectUrl(MANIFEST_PATH))
  ]);
  if (!catalogResponse || !manifestResponse) return null;

  try {
    const catalogResult = await readJsonResponse(catalogResponse, 'Сохранённый каталог');
    const manifestResult = await readJsonResponse(manifestResponse, 'Сохранённый манифест');
    await validateSnapshot(catalogResult.bytes, catalogResult.data, manifestResult.data);
    return {
      catalog: catalogResult.data,
      catalogBytes: catalogResult.bytes,
      manifest: manifestResult.data,
      manifestBytes: manifestResult.bytes
    };
  } catch (error) {
    console.warn('ЭХО: сохранённая версия каталога повреждена.', error);
    return null;
  }
}

async function getMarker(url) {
  const cache = await caches.open(META_CACHE);
  const response = await cache.match(url);
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function setMarker(url, value) {
  const cache = await caches.open(META_CACHE);
  await cache.put(url, new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  }));
}

async function deleteMarker(url) {
  const cache = await caches.open(META_CACHE);
  await cache.delete(url);
}

function contentCacheName(version) {
  return `${CONTENT_CACHE_PREFIX}${version}`;
}

async function storeSnapshot(cache, snapshot) {
  await Promise.all([
    cache.put(projectUrl(CATALOG_PATH), new Response(snapshot.catalogBytes, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Echo-SHA256': snapshot.manifest.catalogSha256
      }
    })),
    cache.put(projectUrl(MANIFEST_PATH), new Response(snapshot.manifestBytes, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }))
  ]);
}

async function getVerifiedCachedBytes(cache, item) {
  const response = await cache.match(projectUrl(item.file));
  if (!response) return null;
  const bytes = await response.arrayBuffer();
  const hash = await sha256(bytes);
  if (hash !== item.sha256 || bytes.byteLength !== item.bytes) return null;
  return bytes;
}

async function storeChapter(cache, item, bytes) {
  await cache.put(projectUrl(item.file), new Response(bytes, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Echo-SHA256': item.sha256,
      'X-Echo-Content-Version': item.number.toString()
    }
  }));
}

async function fetchChapterBytes(item) {
  const response = await fetch(projectUrl(item.file), {
    cache: 'no-store',
    headers: { 'X-Echo-Network-Only': '1' }
  });
  if (!response.ok) {
    throw new Error(`Глава ${item.number}: HTTP ${response.status}.`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== item.bytes || await sha256(bytes) !== item.sha256) {
    throw new Error(`Глава ${item.number}: контрольная сумма не совпала. Файл не установлен.`);
  }
  return bytes;
}

async function downloadSnapshot(snapshot, targetCache, sourceCache, sourceManifest, onProgress) {
  await storeSnapshot(targetCache, snapshot);

  const sourceById = new Map(
    (sourceManifest?.chapters || []).map((item) => [item.id, item])
  );

  let completed = 0;
  let nextIndex = 0;
  let networkCount = 0;
  let copiedCount = 0;
  let cachedCount = 0;
  let firstError = null;

  async function worker() {
    while (nextIndex < snapshot.manifest.chapters.length && !firstError) {
      const item = snapshot.manifest.chapters[nextIndex++];

      try {
        let bytes = await getVerifiedCachedBytes(targetCache, item);
        if (bytes) {
          cachedCount += 1;
        } else {
          const previous = sourceById.get(item.id);
          if (sourceCache && previous && previous.sha256 === item.sha256 && previous.file) {
            const oldBytes = await getVerifiedCachedBytes(sourceCache, previous);
            if (oldBytes) {
              bytes = oldBytes;
              copiedCount += 1;
            }
          }

          if (!bytes) {
            bytes = await fetchChapterBytes(item);
            networkCount += 1;
          }

          await storeChapter(targetCache, item, bytes);
        }

        completed += 1;
        onProgress?.({ completed, total: snapshot.manifest.chapterCount, networkCount, copiedCount, cachedCount });
      } catch (error) {
        firstError = error;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, snapshot.manifest.chapters.length) }, worker)
  );

  if (firstError) throw firstError;
  return { completed, networkCount, copiedCount, cachedCount };
}

async function getActiveCache() {
  const marker = await getMarker(ACTIVE_MARKER);
  if (!marker?.version) return null;
  return caches.open(contentCacheName(marker.version));
}

export async function activatePendingContentVersion() {
  if (!('caches' in globalThis)) return null;

  try {
    const pending = await getMarker(PENDING_MARKER);
    if (!pending?.version) return (await getMarker(ACTIVE_MARKER))?.version || null;

    const cache = await caches.open(contentCacheName(pending.version));
    const snapshot = await readSnapshotFromCache(cache);
    if (!snapshot || snapshot.manifest.contentVersion !== pending.version) {
      console.warn('ЭХО: отложенная версия контента не прошла проверку и не активирована.');
      return (await getMarker(ACTIVE_MARKER))?.version || null;
    }

    await setMarker(ACTIVE_MARKER, { version: pending.version, activatedAt: new Date().toISOString() });
    await deleteMarker(PENDING_MARKER);
    console.info(`ЭХО: активирована версия контента ${pending.version}.`);
    return pending.version;
  } catch (error) {
    console.warn('ЭХО: не удалось активировать подготовленное обновление контента.', error);
    return (await getMarker(ACTIVE_MARKER))?.version || null;
  }
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;

  try {
    const swUrl = new URL('../../sw.js', import.meta.url);
    const scope = new URL('../../', import.meta.url).pathname;
    const registration = await navigator.serviceWorker.register(swUrl, {
      scope,
      updateViaCache: 'none'
    });
    registration.update().catch(() => {});
    return registration;
  } catch (error) {
    console.warn('ЭХО: офлайн-режим Service Worker недоступен.', error);
    return null;
  }
}

async function runOfflineManager(chapters, statusNode) {
  if (!('caches' in globalThis) || !globalThis.crypto?.subtle) {
    setStatus(statusNode, 'Офлайн-кэш недоступен в этом браузере.', 'warning');
    return;
  }

  let activeMarker = await getMarker(ACTIVE_MARKER);
  let activeCache = activeMarker?.version
    ? await caches.open(contentCacheName(activeMarker.version))
    : null;
  let currentSnapshot = await readSnapshotFromCache(activeCache);

  if (!currentSnapshot) {
    try {
      currentSnapshot = await fetchSnapshot(false);
    } catch (error) {
      setStatus(statusNode, 'Не удалось проверить комплект контента. Уже открытые главы остаются доступны.', 'warning');
      console.warn('ЭХО: нет проверенного каталога для офлайн-кэша.', error);
      return;
    }
  }

  if (!activeMarker?.version) {
    activeMarker = { version: currentSnapshot.manifest.contentVersion, activatedAt: new Date().toISOString() };
    activeCache = await caches.open(contentCacheName(activeMarker.version));
    await storeSnapshot(activeCache, currentSnapshot);
    await setMarker(ACTIVE_MARKER, activeMarker);
  }

  let remoteSnapshot = null;
  try {
    remoteSnapshot = await fetchSnapshot(true);
  } catch (error) {
    console.info('ЭХО: свежая версия контента пока недоступна; используется сохранённая.', error);
  }

  if (remoteSnapshot && remoteSnapshot.manifest.contentVersion !== activeMarker.version) {
    const pending = await getMarker(PENDING_MARKER);
    if (pending?.version === remoteSnapshot.manifest.contentVersion) {
      setStatus(statusNode, 'Обновление уже подготовлено. Оно применится при следующем запуске.', 'ready');
      return;
    }

    setStatus(statusNode, 'Обнаружено обновление книги. Проверяем и загружаем изменённые главы…', 'info');
    const stagingCache = await caches.open(contentCacheName(remoteSnapshot.manifest.contentVersion));
    const result = await downloadSnapshot(
      remoteSnapshot,
      stagingCache,
      activeCache,
      currentSnapshot.manifest,
      ({ completed, total, networkCount }) => {
        setStatus(statusNode, `Подготовка обновления: ${completed} из ${total} глав · загружено из сети: ${networkCount}`, 'info');
      }
    );

    await setMarker(PENDING_MARKER, {
      version: remoteSnapshot.manifest.contentVersion,
      preparedAt: new Date().toISOString()
    });
    setStatus(statusNode, `Обновление подготовлено (${result.networkCount} изменённых или новых файлов). Применится при следующем запуске.`, 'ready');
    return;
  }

  const manifest = currentSnapshot.manifest;
  const appChapterIds = new Set(chapters.map((chapter) => chapter.id));
  if (appChapterIds.size !== manifest.chapters.length || manifest.chapters.some((item) => !appChapterIds.has(item.id))) {
    console.warn('ЭХО: каталог активной версии отличается от списка глав текущего экрана.');
  }

  const persisted = await navigator.storage?.persist?.().catch(() => false);
  if (persisted === false) {
    console.info('ЭХО: браузер не подтвердил постоянное хранение, кэш всё равно используется.');
  }

  setStatus(statusNode, `Подготавливаем офлайн-доступ: 0 из ${manifest.chapterCount} глав`, 'info');
  const result = await downloadSnapshot(
    currentSnapshot,
    activeCache,
    null,
    null,
    ({ completed, total }) => {
      setStatus(statusNode, `Подготавливаем офлайн-доступ: ${completed} из ${total} глав`, 'info');
    }
  );

  if (result.completed === manifest.chapterCount) {
    setStatus(statusNode, `Все ${manifest.chapterCount} глав доступны офлайн.`, 'ready');
  }
}

export function startOfflineManager(chapters, statusNode) {
  lastChapters = Array.isArray(chapters) ? chapters : [];
  lastStatusNode = statusNode;

  const run = async () => {
    if (managerRunning) return latestRun;
    managerRunning = true;

    latestRun = runOfflineManager(lastChapters, lastStatusNode)
      .catch((error) => {
        const message = /Failed to fetch|NetworkError|fetch/i.test(error.message)
          ? 'Нет соединения. Продолжим загрузку, когда интернет появится.'
          : `Офлайн-подготовка остановлена: ${error.message}`;
        setStatus(lastStatusNode, message, 'warning');
        console.warn('ЭХО: фоновая подготовка контента остановлена.', error);
      })
      .finally(() => {
        managerRunning = false;
      });

    return latestRun;
  };

  if (!onlineListenerAttached) {
    window.addEventListener('online', () => {
      if (lastChapters.length) run();
    });
    window.addEventListener('offline', () => {
      setStatus(lastStatusNode, 'Нет соединения. Ранее загруженные главы остаются доступны.', 'warning');
    });
    onlineListenerAttached = true;
  }

  return run();
}
