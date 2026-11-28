import { loadArtwork } from './artwork.js';
import { fetchEditionFile, editionMediaUrl } from './offline.js';

const MOODS = new Set(['cool', 'neutral', 'warm']);
const DEFAULT_COVER = Object.freeze({ effects: ['V01','V04','V05'], afterReveal: 'animate', mood: 'neutral' });
export const frontispiecePath = mood => `assets/illustrations/frontispiece-${MOODS.has(mood) ? mood : 'neutral'}.webp`;
export const artworkEnabled = settings => settings.edition !== 'classic' && (settings.edition !== 'custom' || settings.illustrations);
export const motionEnabled = settings => artworkEnabled(settings) && (settings.edition !== 'custom' || settings.artMotion);
export const soundEnabled = settings => settings.edition !== 'classic' && settings.audioConsent === true && (settings.edition !== 'custom' || settings.artSound);

// Failed or slow optional metadata is not allowed to block the book.
export async function getChapterArtwork(chapter, paragraphs) {
  const ids = new Set(paragraphs.map(p => p.getAttribute('data-echo-anchor')));
  if (!chapter.artwork) return null;
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      loadArtwork(chapter, ids, (url, opts) => fetchEditionFile(url, {...opts, signal: controller.signal})),
      new Promise(resolve => { timeout = setTimeout(() => { controller.abort(); resolve(null); }, 1800); })
    ]);
  } catch (error) { console.warn('ЭХО: художественное сопровождение пропущено.', error); return null; }
  finally { clearTimeout(timeout); }
}

export function createArtisticEngine(root, viewport, heading, text, onLayoutChange) {
  let chapter = null, metadata = null, settings = {}, entries = [], active = false;
  let paused = false, frame = 0, idleTimer = 0, currentAudio = null, audioElement = null, audioUrl = null, audioGeneration = 0;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const visible = () => active && !paused && !document.hidden && root.classList.contains('is-active');
  const motion = () => motionEnabled(settings) && !reduced.matches;
  const audioAllowed = () => visible() && soundEnabled(settings);
  const refreshDimensions = () => {
    root.style.setProperty('--art-vw', `${viewport.clientWidth}px`);
    root.style.setProperty('--art-vh', `${viewport.clientHeight}px`);
    root.style.setProperty('--art-pad-top', getComputedStyle(viewport).paddingTop);
  };
  function stopAudio() {
    ++audioGeneration;
    if (audioElement) { audioElement.pause(); audioElement.removeAttribute('src'); audioElement.load(); }
    if(audioUrl){URL.revokeObjectURL(audioUrl);audioUrl=null;}
    if (currentAudio) { currentAudio.node.dataset.playing = 'false'; currentAudio.audioButton.textContent='Воспроизвести звук'; }
    audioElement = null; currentAudio = null;
  }
  async function play(entry, manual = false) {
    if (!audioAllowed() || !entry.scene.audio || (currentAudio === entry && audioElement && !audioElement.paused)) return;
    if (!manual && !settings.audioAuto) return;
    stopAudio();
    const generation=audioGeneration;currentAudio=entry;entry.audioButton.textContent='Загрузка звука…';
    let source;try{source=await editionMediaUrl(entry.scene.audio.file);}catch{if(generation===audioGeneration){stopAudio();entry.audioButton.textContent='Загрузить звук';}return;}
    if(generation!==audioGeneration||!audioAllowed()||!entry.node.isConnected){URL.revokeObjectURL(source);return;}
    audioUrl=source;const element = new Audio(source);
    audioElement = element; currentAudio = entry;
    element.volume = Math.max(0, Math.min(1, settings.audioVolume / 100));
    entry.node.dataset.playing = 'true';
    entry.audioButton.textContent='Остановить звук';
    const finish = () => { if (audioElement === element) stopAudio(); };
    element.addEventListener('ended', finish, { once: true });
    element.addEventListener('error', () => { if (audioElement === element) { finish(); entry.audioButton.textContent = 'Загрузить звук'; } }, {once:true});
    element.play().catch(() => { if (audioElement === element) { finish(); entry.audioButton.textContent = 'Воспроизвести звук'; } });
  }
  function resetIdle() {
    clearTimeout(idleTimer);
    root.dataset.artIdle = '0';
    if (!visible() || !motion()) return;
    idleTimer = setTimeout(() => { if (visible() && motion() && entries.some(e => e.visible && e.image && !e.failed && e.scene.afterReveal === 'animate')) root.dataset.artIdle = '1'; }, 5000);
  }
  function measure(entry, r) {
    const b = entry.node.getBoundingClientRect();
    const width = Math.max(0, Math.min(b.right, r.right) - Math.max(b.left, r.left));
    const height = Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top));
    return {ratio: width * height / Math.max(1, Math.min(b.width,r.width) * Math.min(b.height,r.height)), b};
  }
  function update() {
    frame = 0;
    const on = visible(), r = viewport.getBoundingClientRect();
    let entered = false;
    for (const e of entries) {
      const {ratio, b} = on && !e.node.hidden ? measure(e,r) : {ratio:0,b:null};
      const was = e.visible;
      e.visible = ratio > .06;
      e.node.dataset.active = String(e.visible && motion());
      if (e.visible && e.image && !e.failed) {
        // In scroll mode reveal follows entry into the viewport; fully revealed
        // images remain readable while the user stops or scrolls back slightly.
        let progress = root.dataset.readingMode === 'pages' ? (ratio > .6 ? 1 : ratio) : Math.max(0,Math.min(1,(r.bottom-b.top)/(r.height*.78)));
        e.reveal = Math.max(e.reveal || 0,progress);
        e.node.style.setProperty('--reveal', String(motion() ? e.reveal : 1));
      } else if (!e.visible) { e.reveal = 0; e.node.style.setProperty('--reveal','0'); }
      if (e.visible !== was) entered = true;
      // A cue must leave almost entirely before it can fire on a new visit.
      if (on && ratio <= .04) { e.entered = false; if (currentAudio === e) stopAudio(); }
      if (ratio >= .55 && !e.entered && e.scene.audio) { e.entered = true; play(e); }
    }
    if (!audioAllowed() && currentAudio) stopAudio();
    if (entered) resetIdle();
    if (!on) {clearTimeout(idleTimer); root.dataset.artIdle = '0';}
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(update); }
  function makeEntry(scene, id, number = null) {
    const node = document.createElement('div');
    node.className = 'echo-art'; node.dataset.artId = id;
    node.dataset.mood = MOODS.has(scene.mood) ? scene.mood : 'neutral';
    node.dataset.effects = (scene.effects || []).join(' ');
    node.dataset.animate = String(scene.afterReveal === 'animate');
    const entry = {node, scene, image:null, failed:false, visible:false, entered:false, reveal:0};
    if (scene.image) {
      const picture = document.createElement('div'); picture.className = 'echo-art__picture';
      const img = document.createElement('img'); img.alt = ''; img.draggable = false; img.decoding = 'async';
      const aura = document.createElement('div'); aura.className='echo-art__light'; aura.setAttribute('aria-hidden','true');
      const echo = document.createElement('div'); echo.className='echo-art__echo'; echo.setAttribute('aria-hidden','true');
      const shade = document.createElement('div'); shade.className='echo-art__shade'; shade.setAttribute('aria-hidden','true');
      const retry = document.createElement('button'); retry.type='button'; retry.className='echo-art__retry'; retry.textContent='Загрузить изображение'; retry.hidden=true;
      const load=async()=>{if(entry.loading)return;entry.loading=true;retry.textContent='Загрузка…';try{const source=await editionMediaUrl(scene.image);if(entry.disposed){URL.revokeObjectURL(source);return;}if(entry.url)URL.revokeObjectURL(entry.url);entry.url=source;node.style.setProperty('--art-image',`url("${source}")`);img.src=source;}catch{if(!entry.disposed)onLayoutChange(()=>{entry.failed=true;node.classList.add('is-missing');retry.hidden=false;retry.textContent=navigator.onLine?'Загрузить изображение':'Нет сети · повторить';});}finally{entry.loading=false;}};
      retry.addEventListener('click',load);
      img.addEventListener('load', () => { if (entry.failed) onLayoutChange(() => {entry.failed=false;node.classList.remove('is-missing');retry.hidden=true;retry.textContent='Загрузить изображение';}); schedule(); });
      img.addEventListener('error', () => { if (!node.isConnected) return; onLayoutChange(() => {entry.failed=true;node.classList.add('is-missing');retry.hidden=false;retry.textContent=navigator.onLine?'Загрузить изображение':'Нет сети · повторить';}); });
      picture.append(img,aura,echo,shade); node.append(picture,retry); entry.image=img;
      // The localized echo is a masked duplicate of the SAME source; no
      // crossfading between independently generated geometry variants.
      load();
    } else node.classList.add('echo-art--audio-only');
    if (number !== null) {
      node.classList.add('echo-art--cover');
      const label=document.createElement('h2'); label.className='echo-art__number'; label.textContent=`Глава ${number}`; node.append(label);
    }
    if (scene.audio) {
      const button=document.createElement('button'); button.type='button'; button.className='echo-art__sound'; button.textContent='Воспроизвести звук';
      button.addEventListener('click', () => { if (!audioAllowed()) return; if (currentAudio===entry && audioElement && !audioElement.paused) stopAudio(); else play(entry,true); });
      node.append(button); entry.audioButton=button;
    }
    return entry;
  }
  function clear() {stopAudio(); for (const e of entries){e.disposed=true;if(e.url)URL.revokeObjectURL(e.url);e.node.remove();} entries=[]; clearTimeout(idleTimer); root.dataset.artIdle='0';}
  function rebuild() {
    clear(); if (!chapter) return;
    const showArt=artworkEnabled(settings), showAudio=soundEnabled(settings);
    heading.classList.toggle('has-frontispiece',showArt);
    if (showArt) {
      const cover={...DEFAULT_COVER,...(metadata?.cover || {})};
      cover.mood=MOODS.has(cover.mood)?cover.mood:'neutral'; cover.image=cover.image || frontispiecePath(cover.mood); if(!showAudio)delete cover.audio;
      const entry=makeEntry(cover,'cover',chapter.number); heading.append(entry.node);entries.push(entry);
    }
    const tails=new Map();
    for (const scene of metadata?.scenes || []) {
      const value={...scene};if (!showArt) delete value.image;if (!showAudio) delete value.audio;
      if (!value.image && !value.audio) continue;
      const target=tails.get(scene.after) || [...text.querySelectorAll('[data-echo-anchor]')].find(p=>p.getAttribute('data-echo-anchor')===scene.after);
      if (!target) continue;
      const e=makeEntry(value,scene.id); target.after(e.node); tails.set(scene.after,e.node);entries.push(e);
    }
    refreshDimensions();schedule();
  }
  function setChapter(ch, art, prefs) { chapter=ch;metadata=art;settings=prefs;rebuild(); }
  function configure(prefs) {
    const change=artworkEnabled(settings)!==artworkEnabled(prefs)||soundEnabled(settings)!==soundEnabled(prefs);
    settings=prefs;root.dataset.artMotion=String(motion());
    if (change) rebuild();
    if (audioElement) audioElement.volume=Math.max(0,Math.min(1,prefs.audioVolume/100));
    if (!soundEnabled(prefs)) stopAudio();resetIdle();schedule();
  }
  function setActive(value) { active=value;if (!active) {stopAudio();for(const e of entries){e.entered=false;e.visible=false;e.node.dataset.active='false';}}resetIdle();schedule(); }
  function setPaused(value) {paused=value;if (value) stopAudio();resetIdle();schedule();}
  function capture() {
    const r=viewport.getBoundingClientRect();
    const e=entries.find(e=>!e.node.classList.contains('echo-art--audio-only')&&!e.failed&&measure(e,r).ratio>=.6);
    if (!e) return null;
    const ps=[...text.querySelectorAll('p')];
    const p=e.scene.after?ps.find(p=>p.getAttribute('data-echo-anchor')===e.scene.after):ps[0];
    return {version:2,artworkId:e.node.dataset.artId,paragraphIndex:Math.max(0,ps.indexOf(p)),paragraphId:p?.getAttribute('data-echo-anchor')||null,textOffset:e.scene.after?(p?.textContent.length||0):0,paragraphRatio:0,viewportOffset:24};
  }
  function restore(anchor) {
    const e=entries.find(e=>e.node.dataset.artId===anchor?.artworkId&&!e.failed);
    if (!e) return false;
    viewport.scrollTop+=e.node.getBoundingClientRect().top-viewport.getBoundingClientRect().top;return true;
  }
  for (const event of ['pointerdown','touchstart','keydown','wheel']) root.addEventListener(event,resetIdle,{passive:true});
  viewport.addEventListener('scroll',()=>{resetIdle();schedule();},{passive:true});
  document.addEventListener('visibilitychange',()=>{resetIdle();schedule();});
  reduced.addEventListener?.('change',()=>{root.dataset.artMotion=String(motion());resetIdle();schedule();});
  return {setChapter,configure,setActive,setPaused,capture,restore,schedule,refreshDimensions,resetIdle};
}
