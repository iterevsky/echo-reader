// Verified edition snapshots. A reading session pins a single immutable manifest.
const ROOT = new URL('../../', import.meta.url);
const scoped = encodeURIComponent(ROOT.pathname);
const META = `echo-edition-meta-${scoped}`;
const PREFIX = `echo-edition-${scoped}-`;
const CATALOG = 'data/chapters.json', MANIFEST = 'data/chapters-manifest.json';
const marker = name => new URL(`__echo__/edition-${name}.json`, ROOT).href;
const url = path => new URL(path, ROOT).href;
const versionOK = value => typeof value === 'string' && /^[a-f0-9]{20}$/.test(value);
const pathOK = path => typeof path === 'string' && /^(?:data\/chapters\/\d{3}\.html|data\/artwork\/\d{3}\.json|assets\/illustrations\/[\w-]+\.(?:webp|avif|png|jpe?g)|assets\/audio\/[\w-]+\.(?:mp3|ogg|wav|m4a))$/i.test(path);
const universal = ['cool','neutral','warm'].map(m => `assets/illustrations/frontispiece-${m}.webp`);
let pinned = null, opening = null, running = null, pendingFull = false, lastStatus = null, installedListeners = false;
let currentChapter = null, prefetched = null, fullRequested = false, revision = 0;
const inflight = new Map();
const available = () => !!globalThis.crypto?.subtle;
let storageAvailable=true;
const fail = message => { throw Error(message); };
const mime = path => path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.json') ? 'application/json; charset=utf-8' : path.endsWith('.webp') ? 'image/webp' : path.endsWith('.avif') ? 'image/avif' : path.endsWith('.png') ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : path.endsWith('.mp3') ? 'audio/mpeg' : path.endsWith('.ogg') ? 'audio/ogg' : path.endsWith('.wav') ? 'audio/wav' : 'audio/mp4';
export async function digest(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
const decode = bytes => JSON.parse(new TextDecoder().decode(bytes));
const encode = value => new TextEncoder().encode(value);
const response = (bytes,path) => new Response(bytes,{headers:{'Content-Type':mime(path)}});
function status(message,state='info') { if(lastStatus){lastStatus.textContent=message;lastStatus.dataset.state=state;lastStatus.hidden=false;} }
async function network(path, signal) {
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  if(signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(abort,20000);
  try { const res = await fetch(url(path),{cache:'no-store',headers:{'X-Echo-Network-Only':'1'},signal:ctl.signal}); if(!res.ok) fail(`HTTP ${res.status}: ${path}`); return await res.arrayBuffer(); }
  finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function validateSnapshot(catalogBytes,manifestBytes) {
  const catalog=decode(catalogBytes), manifest=decode(manifestBytes);
  if(catalog.version!==1 || !Array.isArray(catalog.chapters)||!catalog.chapters.length || ![1,2].includes(manifest.schemaVersion)||!versionOK(manifest.contentVersion)||!Array.isArray(manifest.chapters)||manifest.chapterCount!==catalog.chapters.length||manifest.chapters.length!==catalog.chapters.length) fail('Неверный формат комплекта книги.');
  if(await digest(catalogBytes)!==manifest.catalogSha256) fail('Каталог не соответствует манифесту.');
  const files=new Map(), ids=new Set(), numbers=new Set();
  function add(item) {
    if(!item||!pathOK(item.file)||files.has(item.file)||!Number.isSafeInteger(item.bytes)||item.bytes<=0||!/^[a-f0-9]{64}$/.test(item.sha256))fail('Неверная запись манифеста.');
    files.set(item.file,item);
  }
  for(const item of manifest.chapters) {add(item);if(typeof item.id!=='string'||!Number.isInteger(item.number)||item.number<=0||ids.has(item.id)||numbers.has(item.number))fail('Повтор или неверный ID главы.');ids.add(item.id);numbers.add(item.number);}
  for(const chapter of catalog.chapters){const item=files.get(chapter.file);if(!item||item.id!==chapter.id||item.number!==chapter.number||typeof chapter.title!=='string'||!/^data\/chapters\/\d{3}\.html$/.test(chapter.file))fail('Каталог и текст расходятся.'); if(chapter.artwork&&!/^data\/artwork\/\d{3}\.json$/.test(chapter.artwork))fail('Неверный путь художественной разметки.');}
  if(new Set(catalog.chapters.map(c=>c.file)).size!==catalog.chapters.length)fail('Повтор файла главы.');
  if(manifest.totalBytes!==manifest.chapters.reduce((a,x)=>a+x.bytes,0))fail('Неверный размер текста.');
  const media=manifest.schemaVersion===2?manifest.media:[];
  if(!Array.isArray(media))fail('Нет списка мультимедиа.');
  for(const item of media){if(/^data\/chapters\//.test(item.file)||!Array.isArray(item.chapters)||item.chapters.some(id=>!ids.has(id)))fail('Неверная привязка мультимедиа.');add(item);}
  if(manifest.schemaVersion===2){for(const p of universal)if(!files.has(p))fail('Нет общего фронтисписа.');for(const c of catalog.chapters)if(c.artwork&&!files.has(c.artwork))fail('Нет художественной разметки главы.');if(manifest.mediaBytes!==media.reduce((a,x)=>a+x.bytes,0))fail('Неверный размер мультимедиа.');}
  const source=manifest.catalogSha256+'\n'+manifest.chapters.map(x=>`${x.id}:${x.sha256}`).join('\n')+(manifest.schemaVersion===2?'\nmedia-v2\n'+media.map(x=>`${x.file}:${x.sha256}:${x.bytes}:${x.chapters.join(',')}`).join('\n'):'');
  if((await digest(encode(source))).slice(0,20)!==manifest.contentVersion)fail('Версия комплекта не соответствует контрольным суммам.');
  return {catalog,manifest,catalogBytes,manifestBytes,files,media,version:manifest.contentVersion};
}
async function readMarker(name){try{return await (await (await caches.open(META)).match(marker(name)))?.json();}catch{return null;}}
async function writeMarker(name,value){await (await caches.open(META)).put(marker(name),new Response(JSON.stringify(value)));}
async function removeMarker(name){await (await caches.open(META)).delete(marker(name));}
async function remote(){const [c,m]=await Promise.all([network(CATALOG),network(MANIFEST)]);return validateSnapshot(c,m);}
async function fromCache(cache){try{const [c,m]=await Promise.all([cache.match(url(CATALOG)),cache.match(url(MANIFEST))]);if(!c||!m)return null;return await validateSnapshot(await c.arrayBuffer(),await m.arrayBuffer());}catch{return null;}}
async function openVersion(version){if(!versionOK(version))return null;try{const snap=await fromCache(await caches.open(PREFIX+version));return snap?.version===version?snap:null;}catch{return null;}}
async function persistSnapshot(snap){const cache=await caches.open(PREFIX+snap.version);await cache.put(url(CATALOG),response(snap.catalogBytes,CATALOG));await cache.put(url(MANIFEST),response(snap.manifestBytes,MANIFEST));return cache;}
async function checked(cache,item){try{const r=await cache.match(url(item.file));if(!r)return null;const b=await r.arrayBuffer();if(b.byteLength===item.bytes&&await digest(b)===item.sha256)return b;}catch{}return null;}
async function completeText(snap){const cache=await caches.open(PREFIX+snap.version);for(const item of snap.manifest.chapters)if(!await checked(cache,item))return false;return true;}
// Web Locks serialize marker changes where supported. Immutable versions also
// keep open sessions isolated when the API is not present.
const locked = task => globalThis.navigator?.locks?.request ? navigator.locks.request(META,task) : task();
async function initialize(){
  if(!available()) fail('Для проверенного издания нужен HTTPS или localhost.');
  try{await caches.open(META);}catch{storageAvailable=false;return remote();}
  return locked(async()=>{
    const active=await readMarker('active'), pending=await readMarker('pending');
    if(pending?.version){
      try {
        const candidate=await openVersion(pending.version);
        if(candidate&&await completeText(candidate)){
          await writeMarker('active',{version:candidate.version,previous:active?.version||null});
          // A failed cleanup must not undo a successful activation.
          await removeMarker('pending').catch(()=>{});
          return candidate;
        }
        await removeMarker('pending').catch(()=>{});
      } catch(e) { console.warn('ЭХО: активация отложена; сохраняем прежнее издание.',e); }
    }
    const saved=await openVersion(active?.version);if(saved)return saved;
    // Recover only a fully verified previous edition if the marker is damaged.
    const previous=await openVersion(active?.previous);if(previous&&await completeText(previous)){await writeMarker('active',{version:previous.version}).catch(()=>{});return previous;}
    let snap;
    try{snap=await remote();}catch{
      // Shell install stores a coherent catalog/manifest pair. Legacy caches
      // are read only; never overwrite another version's catalog.
      const keys=(await caches.keys()).filter(k=>k.startsWith('echo-shell-')).sort().reverse();
      for(const key of keys){snap=await fromCache(await caches.open(key));if(snap)break;}
      if(!snap)fail('Не удалось получить проверенный каталог. Подключитесь к интернету.');
    }
    try{await persistSnapshot(snap);await writeMarker('active',{version:snap.version});}catch(e){storageAvailable=false;console.warn('ЭХО: сохранение издания недоступно; читаем из сети.',e);}return snap;
  });
}
async function edition(){if(pinned)return pinned;if(!opening)opening=initialize().then(s=>pinned=s).finally(()=>{opening=null;});return opening;}
// Kept for compatibility with the shell; initialization is deferred until catalog is needed.
export async function activatePendingContentVersion(){return null;}
export async function loadEditionCatalog(){return (await edition()).catalog;}
async function getFile(snap,path,signal){
  const item=snap.files.get(path);if(!item)fail('Файл отсутствует в проверенном манифесте: '+path);
  const key=snap.version+':'+path;if(inflight.has(key))return inflight.get(key);
  const task=(async()=>{
    let cache=null,b=null;try{if(storageAvailable)cache=await caches.open(PREFIX+snap.version);}catch{storageAvailable=false;}if(cache){b=await checked(cache,item);if(b)return b;}
    // Reuse verified bytes from previous versions, including the legacy PWA.
    if(cache){try{const keys=(await caches.keys()).filter(k=>k!==PREFIX+snap.version&&(k.startsWith(PREFIX)||k.startsWith('echo-content-')||k.startsWith('echo-shell-')));
    for(const name of keys){b=await checked(await caches.open(name),item);if(b)break;}}catch{}}
    if(!b){b=await network(path,signal);if(b.byteLength!==item.bytes||await digest(b)!==item.sha256)fail('Файл не прошёл проверку целостности: '+path);}
    // Reading can continue after quota failure, but the file must not be
    // counted as downloaded until a subsequent verification succeeds.
    try{if(cache)await cache.put(url(path),response(b,path));}catch(e){console.warn('ЭХО: файл не сохранён в кеше',e);}
    return b;
  })().finally(()=>inflight.delete(key));inflight.set(key,task);return task;
}
export async function fetchEditionFile(path,options={}){const snap=await edition();return response(await getFile(snap,path,options.signal),path);}
export async function editionMediaUrl(path){const r=await fetchEditionFile(path);return URL.createObjectURL(await r.blob());}
async function counts(snap,list){const cache=await caches.open(PREFIX+snap.version);let n=0,bytes=0;for(const item of list)if(await checked(cache,item)){n++;bytes+=item.bytes;}return {n,bytes};}
async function download(snap,list,progress){let next=0,done=0,errors=[];async function worker(){while(next<list.length){const item=list[next++];try{await getFile(snap,item.file);}catch(e){errors.push(item.file);}progress?.(++done,list.length);}}await Promise.all([worker(),worker()]);return errors;}
const mb = b => (b/1024/1024).toFixed(2).replace('.',',')+' МБ';
async function shellReady(){
  const controller=globalThis.navigator?.serviceWorker?.controller, build=globalThis.document?.querySelector?.('meta[name="echo-build"]')?.content;
  if(!controller||!build)return false;
  try{return await new Promise(resolve=>{const channel=new MessageChannel();const finish=value=>{clearTimeout(timer);channel.port1.close();resolve(value);};const timer=setTimeout(()=>finish(false),1000);channel.port1.onmessage=e=>finish(e.data?.build===build);try{controller.postMessage({type:'ECHO_GET_BUILD'},[channel.port2]);}catch{finish(false);}});}catch{return false;}
}
async function report(snap,extra=''){
  const t=await counts(snap,snap.manifest.chapters), m=await counts(snap,snap.media);
  const complete=t.n===snap.manifest.chapters.length&&m.n===snap.media.length;
  const controlled=await shellReady();
  status(`Текст: ${t.n}/${snap.manifest.chapters.length} глав. Медиа: ${m.n}/${snap.media.length} файлов (${mb(m.bytes)} из ${mb(snap.manifest.mediaBytes||0)}). ${complete?(controlled?'Комплект проверен и сохранён.':'Комплект сохранён; для запуска без сети нужен активный Service Worker.'):'Загруженные файлы проверены; комплект пока неполный.'}${extra?' '+extra:''}`,complete&&controlled?'ready':'info');
  return {text:t,media:m,complete};
}
async function stageUpdate(snap){
  let fresh;try{fresh=await remote();}catch{return 'Свежую версию проверить не удалось.';}
  if(fresh.version===snap.version)return 'Новая версия не обнаружена.';
  const active=await readMarker('active');if(active?.version===fresh.version)return 'Новая версия доступна после повторного открытия приложения.';
  await persistSnapshot(fresh);
  await download(fresh,fresh.manifest.chapters,(n,total)=>status(`Подготовка обновления: ${n}/${total} глав.`));
  if(!await completeText(fresh))return 'Обновление не завершено; текущая версия сохранена.';
  // A newer manifest can arrive while this one downloads. Only mark the version
  // still published at the end of staging, never an obsolete partial snapshot.
  return locked(async()=>{let latest;try{latest=await remote();}catch{return 'Обновление загружено, ожидается повторная проверка сети.';}if(latest.version!==fresh.version)return 'Появилась более новая версия; повторим проверку.';const current=await readMarker('active');if(current?.version!==fresh.version)await writeMarker('pending',{version:fresh.version});return 'Обновление текста подготовлено. Применится при следующем запуске.';});
}
function nearby(snap){const index=snap.catalog.chapters.findIndex(c=>c.id===currentChapter);const ids=new Set(snap.catalog.chapters.slice(Math.max(0,index-1),Math.max(0,index)+3).map(c=>c.id));return snap.media.filter(x=>universal.includes(x.file)||x.chapters.some(id=>ids.has(id)));}
async function run(){
  const snap=await edition();const full=pendingFull||fullRequested;pendingFull=false;
  if(!storageAvailable){status('Браузер не разрешил сохранять файлы. Чтение из сети доступно; офлайн-комплект не подготовлен.','warning');return {complete:false};}
  if(full)await navigator.storage?.persist?.().catch(()=>false);
  await download(snap,snap.manifest.chapters,(n,total)=>status(`Проверка и загрузка текста: ${n}/${total} глав.`));
  await download(snap,full?snap.media:nearby(snap),(n,total)=>status(`Загрузка художественных файлов: ${n}/${total}.`));
  const extra=await stageUpdate(snap);return report(snap,extra);
}
export function startOfflineManager(chapters,node,options={}){
  if(node)lastStatus=node;if(options.full){pendingFull=true;fullRequested=true;}
  if(!installedListeners){installedListeners=true;navigator.serviceWorker?.addEventListener('controllerchange',()=>{if(pinned&&!running)report(pinned).catch(()=>{});});window.addEventListener('online',()=>startOfflineManager([],lastStatus));document.addEventListener('visibilitychange',()=>{if(!document.hidden)startOfflineManager([],lastStatus);});window.setInterval(()=>{if(!document.hidden&&navigator.onLine!==false)startOfflineManager([],lastStatus);},5*60*1000);}
  if(running)return running.then(result=>pendingFull?startOfflineManager([],lastStatus):result);
  running=run().catch(e=>{status('Офлайн-подготовка остановлена: '+e.message,'warning');return {error:e.message};}).finally(()=>{running=null;});return running;
}
export async function editionDownloadInfo(){const s=await edition();return {bytes:s.manifest.totalBytes+(s.manifest.mediaBytes||0),mediaBytes:s.manifest.mediaBytes||0,chapters:s.manifest.chapterCount,media:s.media.length};}
export function prefetchEditionChapter(chapterId){if(currentChapter===chapterId)return;currentChapter=chapterId;const id=++revision;clearTimeout(prefetched);prefetched=setTimeout(async()=>{try{const s=await edition();if(id!==revision||!storageAvailable)return;await download(s,nearby(s));if(id===revision&&!running)await report(s);}catch{}},700);}
export async function registerServiceWorker(){if(!('serviceWorker' in navigator)||!window.isSecureContext)return null;try{return await navigator.serviceWorker.register(new URL('../../sw.js',import.meta.url),{scope:ROOT.pathname,updateViaCache:'none'});}catch(e){console.warn('ЭХО: Service Worker недоступен.',e);return null;}}
