// Optional, versioned artwork sidecar.
const EFFECTS = new Set(['V01','V02','V03','V04','V05']);
const AUDIO_TYPES = new Set(['A01','A02','A03']);
const IMAGE = /^assets\/illustrations\/[A-Za-z0-9][A-Za-z0-9_-]*\.(webp|avif|png|jpe?g)$/i;
const AUDIO = /^assets\/audio\/[A-Za-z0-9][A-Za-z0-9_-]*\.(mp3|ogg|wav|m4a)$/i;
const SIDECAR = /^data\/artwork\/[0-9]{3}\.json$/;
function assert(ok, message) { if (!ok) throw new Error(message); }
function checkEffects(value) {
  assert(value === undefined || (Array.isArray(value) &&
    value.every(id => EFFECTS.has(id)) && new Set(value).size === value.length),
    'Неизвестный или повторный визуальный эффект.');
}
function checkMedia(scene) {
  assert(scene && typeof scene === 'object', 'Неверная художественная сцена.');
  assert(!('image' in scene) || IMAGE.test(scene.image), 'Недопустимый путь изображения.');
  assert(!('audio' in scene) || (scene.audio && AUDIO.test(scene.audio.file) &&
    AUDIO_TYPES.has(scene.audio.type)), 'Недопустимое описание звука.');
  checkEffects(scene.effects);
  assert(scene.mood === undefined || ['cool','neutral','warm'].includes(scene.mood), 'Неизвестное световое состояние.');
  assert(scene.afterReveal === undefined || ['still','animate'].includes(scene.afterReveal), 'Неизвестное поведение после проявления.');
}
export function validateArtwork(value, chapterId, paragraphIds) {
  assert(value && value.schemaVersion === 1 && value.chapter === chapterId,
    'Художественная разметка не соответствует главе.');
  if (value.cover != null) {
    checkMedia(value.cover);
    assert(value.cover.image || value.cover.mood, 'Нет изображения или светового состояния вступления.');
  }
  assert(Array.isArray(value.scenes), 'Список сцен отсутствует.');
  const ids = new Set();
  for (const scene of value.scenes) {
    checkMedia(scene);
    assert(typeof scene.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(scene.id) &&
      scene.id !== 'cover' && !ids.has(scene.id), 'Неверный или повторный ID сцены.');
    ids.add(scene.id);
    assert(typeof scene.after === 'string' && paragraphIds.has(scene.after),
      'Сцена не привязана к существующему абзацу: ' + scene.id);
    assert(scene.image || scene.audio, 'Пустая художественная сцена.');
  }
  return value;
}
export async function loadArtwork(chapter, paragraphIds, fetcher = fetch) {
  if (!chapter.artwork) return null;
  assert(SIDECAR.test(chapter.artwork), 'Недопустимый путь художественной разметки.');
  const response = await fetcher(chapter.artwork, { cache: 'no-store' });
  assert(response.ok, 'Не удалось загрузить художественную разметку.');
  return validateArtwork(await response.json(), chapter.id, paragraphIds);
}
