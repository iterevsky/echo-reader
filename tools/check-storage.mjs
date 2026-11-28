import assert from 'node:assert/strict';
const store=new Map();let denied=false;
globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>{if(denied)throw Error('quota');store.set(k,v);}};
const s=await import('../scripts/core/storage.js');const key='echo-reader-state-v1';let n=0;const pass=name=>console.log('PASS',++n,name);
s.updateState({currentChapterId:'chapter-042',currentChapterNumber:42,readChapterIds:['chapter-001']});s.updateReaderSettings({fontSize:24,theme:'light'});assert.equal(s.getState().currentChapterNumber,42);pass('settings preserve reading progress');
s.resetProgress();assert.equal(s.getState().currentChapterId,null);assert.equal(s.getState().readerSettings.fontSize,24);store.set(key,'corrupt');assert.equal(s.getState().currentChapterId,null);assert.deepEqual(s.getState().readChapterIds,[]);pass('corrupt primary does not resurrect intentionally reset progress');
denied=true;const warn=console.warn;console.warn=()=>{};s.updateReaderSettings({fontSize:28});assert.equal(s.getState().readerSettings.fontSize,28);denied=false;s.updateReaderSettings({theme:'dark'});console.warn=warn;assert.equal(s.getState().readerSettings.fontSize,28);store.set(key,'corrupt');assert.equal(s.getState().readerSettings.fontSize,28);pass('volatile state survives quota and is mirrored after recovery');
console.log('Total:',n);
