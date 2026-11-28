import { createNavigation, parseRoute } from '../scripts/core/navigation.js';
import { fingerprint, assignParagraphIds, locateParagraph, migrateLegacyAnchor, resolveReadingOffset } from '../scripts/core/anchors.js';
import { validateArtwork, loadArtwork } from '../scripts/core/artwork.js';
import { getState, updateState, updateReaderSettings, resetProgress } from '../scripts/core/storage.js';

const results = [];
function check(condition, name) {
  if (!condition) throw new Error(name);
  results.push(name);
}
const entries=[null], listeners={}; let at=0;
const history={get state(){return entries[at]},replaceState(v){entries[at]=v},
  pushState(v){entries.splice(++at);entries.push(v)},
  back(){if(at>0){at--;listeners.popstate({state:entries[at]})}}};
let route;
const nav=createNavigation(v=>route=v,{history,addEventListener(k,fn){listeners[k]=fn},removeEventListener(k){delete listeners[k]}});
check(nav.current().screen==='splash','Начальное состояние');
nav.push('contents');nav.push('reader','chapter-001');nav.replace('reader','chapter-002');
nav.push('settings','chapter-002');nav.back();
check(route.screen==='reader'&&route.chapterId==='chapter-002','Назад из настроек');
nav.back();check(route.screen==='contents','Назад из нескольких глав');
nav.back();check(route.screen==='splash','Назад на заставку');
check(parseRoute({echoNavigation:{version:1,screen:'reader'}})===null,'Некорректный маршрут отклонён');
check(migrateLegacyAnchor({paragraphIndex:2,textOffset:4},'Начало.','Начало').paragraphIndex===3,'Перенос удалённого абзаца v1');
check(migrateLegacyAnchor({paragraphIndex:0,textOffset:3},'Начало.  Текст','Начало').textOffset===12,'Перенос удалённой части v1');
check(migrateLegacyAnchor({version:2,paragraphIndex:0},'Начало.','Начало').paragraphIndex===0,'Без повторной миграции');
check(resolveReadingOffset('Вводная. Нужная фраза.',{textOffset:2,quote:'Нужная фраза',quoteOffset:2})===11,'Восстановление позиции после вставки текста');
check(fingerprint('текст')===fingerprint('текст')&&fingerprint('текст')!==fingerprint('другой'),'Устойчивый отпечаток');
function para(text,id=null){const m=new Map(id?[['data-paragraph-id',id]]:[]);return {textContent:text,id:'',getAttribute:k=>m.get(k)||null,setAttribute:(k,v)=>m.set(k,v)}}
const p=[para('один','p1'),para('два'),para('два')];
assignParagraphIds({querySelectorAll:()=>p});
check(p[1].getAttribute('data-echo-anchor')!==p[2].getAttribute('data-echo-anchor'),'Одинаковые абзацы имеют разные ID');
check(locateParagraph([p[2],p[0],p[1]],{paragraphId:'p1',paragraphIndex:0})===p[0],'Привязка переживает перестановку');
const example={schemaVersion:1,chapter:'chapter-001',scenes:[{id:'a',after:'p1',image:'assets/illustrations/a.webp',effects:['V01']}]};
check(validateArtwork(example,'chapter-001',new Set(['p1']))===example,'Корректная художественная разметка');
let rejected=false;try{validateArtwork(example,'chapter-001',new Set())}catch{rejected=true}check(rejected,'Потерянная привязка отклонена');
check(await loadArtwork({id:'chapter-001'},new Set(),()=>{throw Error('Не должно быть запроса')})===null,'Старая глава без разметки');
const values=new Map();let fail=false;
globalThis.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>{if(fail)throw Error('test quota');values.set(k,v)}};
updateReaderSettings({fontSize:24});updateState({currentChapterId:'chapter-002',readChapterIds:['chapter-001']});
resetProgress();check(getState().currentChapterId===null&&getState().readChapterIds.length===0&&getState().readerSettings.fontSize===24,'Сброс прогресса сохраняет настройки');
fail=true;updateState({currentChapterId:'chapter-003'});
check(getState().currentChapterId==='chapter-003','Состояние в памяти при отказе хранилища');
fail=false;updateState({currentChapterNumber:3});
check(JSON.parse(values.get('echo-reader-state-v1')).currentChapterId==='chapter-003','Повторная успешная запись сохраняет состояние сеанса');

console.log(results.length+' проверок пройдено: '+results.join('; '));
