from pathlib import Path
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
import re,base64,json,os,posixpath
W=int(os.getenv('W',390));H=int(os.getenv('H',844)); root=Path(__file__).resolve().parents[1]
html=BeautifulSoup((root/'index.html').read_text(),'html.parser'); base=html.new_tag('base',href='https://echo.test/');html.head.insert(0,base)
for x in list(html.find_all('script')):x.decompose()
for x in list(html.find_all('link')):
 if x.get('rel')==['stylesheet']:
  style=html.new_tag('style');style.string=(root/x['href'].removeprefix('./')).read_text();x.replace_with(style)
 else:x.decompose()
for x in html.find_all('img',src=True):
 path=root/x['src'].removeprefix('./'); x['src']='data:image/png;base64,'+base64.b64encode(path.read_bytes()).decode()
files={str(p.relative_to(root)):p.read_text() for p in (root/'data').rglob('*') if p.is_file()}
images={str(p.relative_to(root)):'data:image/webp;base64,'+base64.b64encode(p.read_bytes()).decode() for p in (root/'assets/illustrations').glob('*.webp')}
mods=['scripts/core/storage.js','scripts/core/navigation.js','scripts/core/anchors.js','scripts/core/artwork.js','scripts/core/artistic-engine.js','scripts/core/pagination.js','scripts/screens/contents.js','scripts/screens/reader.js','scripts/screens/info.js','scripts/core/app.js']
bundle='const __mods={};\n__mods["scripts/core/offline.js"]={activatePendingContentVersion:async()=>{},registerServiceWorker:async()=>null,loadEditionCatalog:async()=> (await fetch("data/chapters.json")).json(),fetchEditionFile:(path,opts)=>fetch(path,opts),editionMediaUrl:async path=>path,editionDownloadInfo:async()=>({chapters:86,media:3,bytes:1686384}),prefetchEditionChapter:()=>{},startOfflineManager:async(chapters,node,options)=>{window.downloadLog=(window.downloadLog||[]).concat([Boolean(options?.full)]);node.textContent="Текст: 86/86 глав. Медиа: 3/3 файлов. (стенд)";node.hidden=false;}};\n'

for path in mods:
 s=(root/path).read_text();exports=re.findall(r'^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)',s,re.M)
 s=re.sub(r'^import\s+\{([\s\S]*?)\}\s+from\s+[\'\"]([^\'\"]+)[\'\"];',lambda m:'const {'+m[1]+'}=__mods['+json.dumps(posixpath.normpath(posixpath.join(posixpath.dirname(path),m[2])))+'];',s,flags=re.M)
 s=re.sub(r'^export\s+','',s,flags=re.M)
 bundle+=f'__mods[{json.dumps(path)}]=(()=>{{\n{s}\nreturn {{{",".join(exports)}}};\n}})();\n'
# fixture ONLY in test input, no change to actual chapter or catalog
cat=json.loads(files['data/chapters.json']);cat['chapters'][0]['artwork']='data/artwork/001.json';cat['chapters'][1]['artwork']='data/artwork/002.json';files['data/chapters.json']=json.dumps(cat)
for n,mood in [(1,'cool'),(2,'warm')]:
 key=f'data/chapters/{n:03}.html';bs=BeautifulSoup(files[key],'html.parser'); ps=bs.select('article.chapter-content p');ps[3]['data-paragraph-id']='test-anchor';files[key]=str(bs)
 files[f'data/artwork/{n:03}.json']=json.dumps({'schemaVersion':1,'chapter':f'chapter-{n:03}','cover':{'mood':mood},'scenes':[{'id':'test-scene','after':'test-anchor','image':'assets/illustrations/frontispiece-neutral.webp','effects':['V01','V02','V03','V04','V05'],'afterReveal':'animate','audio':{'file':'assets/audio/test.mp3','type':'A01'}}]})
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox']);ctx=b.new_context(viewport={'width':W,'height':H},is_mobile=W<600,has_touch=W<600);p=ctx.new_page();p.set_default_timeout(7000);errs=[];dialogs=[];p.on('pageerror',lambda e:errs.append(str(e)));p.on('dialog',lambda d:(dialogs.append(d.message),d.accept() if d.type=='confirm' else d.dismiss()));p.set_content(str(html))
 p.evaluate('''([files,images])=>{const values=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}});Object.defineProperty(window,'sessionStorage',{value:{getItem:k=>null,setItem:()=>{},removeItem:()=>{}}});window.fetch=async path=>{const name=String(path).replace(/^\\.\\//,'');return new Response(files[name]||'',{status:name in files?200:404})};const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');Object.defineProperty(HTMLImageElement.prototype,'src',{...desc,set(v){desc.set.call(this,images[v]||v)}});const old=CSSStyleDeclaration.prototype.setProperty;CSSStyleDeclaration.prototype.setProperty=function(k,v,...rest){if(k==='--art-image')for(const [path,url] of Object.entries(images))if(v.includes(path))v='url("'+url+'")';return old.call(this,k,v,...rest)};window.audioLog=[];window.Audio=class extends EventTarget{constructor(src){super();this.src=src;this.paused=true;}play(){this.paused=false;audioLog.push(['play',this.src]);return Promise.resolve()}pause(){this.paused=true;audioLog.push(['pause',this.src])}removeAttribute(){}load(){}}}''',[files,images])
 p.evaluate('code=>{(new Function(code))()}',bundle)
 def a(v,msg='assertion'): assert v,msg
 def state():return p.evaluate("JSON.parse(localStorage.getItem('echo-reader-state-v1'))")
 def anchor():return state()['readingAnchor']
 def route(s):p.wait_for_function('s=>history.state?.echoNavigation?.screen===s',arg=s)
 def enter():
  p.locator('[data-splash-action]').click();p.locator('[data-splash-action]').click();p.wait_for_selector('[data-splash]',state='hidden',timeout=6000);route('contents')
 def chapter(n):
  p.locator(f'[data-chapter-id="chapter-{n:03}"]').click();route('reader');p.wait_for_function('id=>history.state.echoNavigation.chapterId===id',arg=f'chapter-{n:03}');p.wait_for_timeout(400)
 def settings(tab='appearance'):
  if not p.locator('#reader-screen').evaluate("el=>el.classList.contains('controls-visible')"): p.locator('#reader-scroll').click(position={'x':W//2,'y':H//2})
  p.locator('[data-reader-settings]').click();route('settings');p.locator(f'[data-settings-tab={tab}]').click()
 def close():p.locator('[data-settings-close]').first.click();route('reader');p.wait_for_timeout(250)
 def tap(x):p.locator('#reader-scroll').click(position={'x':int(x*W),'y':H//2});p.wait_for_timeout(380)
 def go(id):p.locator('#reader-scroll').evaluate("(el,id)=>{const f=el.querySelector('[data-art-id=\"'+id+'\"]');el.scrollTop+=f.getBoundingClientRect().top-el.getBoundingClientRect().top}",id);p.wait_for_timeout(400)
 def exact(n):
  got=p.locator('#reader-text').evaluate("el=>[...el.querySelectorAll('p')].map(x=>x.innerHTML)");want=p.evaluate("async n=>[...new DOMParser().parseFromString(await (await fetch('data/chapters/'+String(n).padStart(3,'0')+'.html')).text(),'text/html').querySelectorAll('article.chapter-content p')].map(x=>x.innerHTML)",n);a(got==want)
 def geom():return p.locator('.reader-article').evaluate("""el=>{const vp=document.querySelector('#reader-scroll'),r=el.getBoundingClientRect(),stride=vp.clientWidth, pages=new Set();const w=document.createTreeWalker(document.querySelector('#reader-text'),NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){if(n.parentElement.closest('.echo-art')||!n.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(n);for(const b of range.getClientRects())if(b.width)pages.add(Math.floor((b.left-r.left+.5)/stride))}const art=[...el.querySelectorAll('.echo-art')].map(a=>({id:a.dataset.artId,page:Math.floor((a.getBoundingClientRect().left-r.left+.5)/stride),box:a.getBoundingClientRect().toJSON()}));return {pages:[...pages].sort((a,b)=>a-b),art,current:Math.round(-new DOMMatrixReadOnly(getComputedStyle(el).transform).m41/stride)}}""")
 passed=[]
 def test(name,f):
  if os.getenv('ECHO_KEYBOARD_ONLY')=='1' and name not in ['open chapter','consent denied','keyboard page turn and visible focus']:return
  if os.getenv('ECHO_DOWNLOADS_ONLY')=='1':
   if name not in ['open chapter','consent denied','download status and manual refresh (mock)','no JS errors or unexpected dialogs']:return
   if name=='no JS errors or unexpected dialogs':a(not errs,str(errs));passed.append(name);print('PASS',name,flush=True);return
  f();passed.append(name);print('PASS',name,flush=True)
 test('open chapter',lambda:(enter(),chapter(1),exact(1),a(p.locator('.echo-art--cover').get_attribute('data-mood')=='cool'),a(anchor()['artworkId']=='cover',str(anchor()))))
 test('consent denied',lambda:(p.locator('[data-audio-choice=no]').click(),p.wait_for_timeout(400),a(state()['readerSettings']['audioConsent']==False),a(p.evaluate('audioLog.length')==0)))
 def idle():
  p.wait_for_timeout(5400);a(p.locator('#reader-screen').get_attribute('data-art-idle')=='1');a(p.locator('.echo-art--cover .echo-art__light').evaluate('e=>getComputedStyle(e).animationName')=='echo-light');p.screenshot(path=f'/tmp/echo-art-cover-{W}.png');p.locator('#reader-scroll').click(position={'x':W//2,'y':H//2});a(p.locator('#reader-screen').get_attribute('data-art-idle')=='0')
 test('idle light and immediate reset',idle)
 def paging():
  settings('reading');p.locator('select[data-reading-mode]').select_option('pages');p.locator('select[data-page-animation]').select_option('none');close();g=geom();print('GEOM',g,flush=True);a(g['current']==0);a(g['art'][0]['page']==0);a(anchor()['artworkId']=='cover',str(anchor()));a(g['pages'][0]==1,str(g));a(g['art'][1]['page'] not in g['pages'],str(g));p.screenshot(path=f'/tmp/echo-art-paged-{W}.png');tap(.85);a(geom()['current']==1);a(anchor()['artworkId'] is None,str(anchor()));exact(1)
 test('cover is independent page and scene does not overlap text',paging)
 def scene():
  g=geom();target=g['art'][1]['page'];
  for _ in range(target-g['current']):tap(.85)
  a(anchor()['artworkId']=='test-scene',str(anchor()));settings('reading');p.locator('select[data-reading-mode]').select_option('scroll');close();a(anchor()['artworkId']=='test-scene',str(anchor()));exact(1)
 test('scene anchor survives mode change',scene)
 def sound():
  settings('art');p.locator('[data-art-setting=audioConsent]').check();close();go('cover');go('test-scene');p.wait_for_timeout(250);a(any(x[0]=='play' for x in p.evaluate('audioLog')),str(p.evaluate('audioLog')));p.locator('#reader-scroll').evaluate('el=>el.scrollTop=0');p.wait_for_timeout(350);a(any(x[0]=='pause' for x in p.evaluate('audioLog')));before=p.evaluate("audioLog.filter(x=>x[0]==='play').length");go('test-scene');a(p.evaluate("audioLog.filter(x=>x[0]==='play').length")==before+1)
 test('sound consent, stop and repeat on re-entry (mock audio)',sound)
 def classic():
  p.locator('#reader-scroll').evaluate('el=>el.scrollTop=el.scrollHeight*.65');p.wait_for_timeout(400);before=anchor();settings('art');p.locator('[data-art-setting=edition]').select_option('classic');close();after=anchor();a(p.locator('.echo-art').count()==0);a(abs(before['paragraphIndex']-after['paragraphIndex'])<=1,str((before,after)));exact(1)
 test('classic mode removes media and preserves text position',classic)
 def custom():
  settings('art');p.locator('[data-art-setting=edition]').select_option('custom');p.locator('[data-art-setting=artMotion]').uncheck();close();a(p.locator('#reader-screen').get_attribute('data-art-motion')=='false');go('cover');p.wait_for_timeout(5200);a(p.locator('#reader-screen').get_attribute('data-art-idle')=='0');exact(1)
 test('custom motion off',custom)
 def theme():
  p.locator('#reader-scroll').evaluate('el=>el.scrollTop=el.scrollHeight*.7');p.wait_for_timeout(400);before=anchor();settings();p.locator('[data-art-setting=theme]').select_option('light');p.screenshot(path=f'/tmp/echo-settings-light-{W}.png');a(p.locator('html').get_attribute('data-echo-theme')=='light');a(p.locator('#reader-screen').evaluate('el=>getComputedStyle(el).backgroundColor')=='rgb(243, 238, 229)');a(p.locator('[data-settings-panel=appearance]').is_visible());a(not p.locator('[data-settings-panel=art]').is_visible());close();after=anchor();a(abs(before['paragraphIndex']-after['paragraphIndex'])<=1,str((before,after)));exact(1)
 test('light theme and position',theme)
 def resume():
  settings('reading');p.locator('[data-art-setting=reopen]').select_option('cover');close();before=anchor();p.evaluate('history.back()');route('contents');chapter(1);p.locator('[data-resume-cover]').wait_for(state='visible');a(anchor()['paragraphIndex']==before['paragraphIndex'],str((before,anchor())));p.locator('[data-resume-continue]').click();a(not p.locator('[data-resume-cover]').is_visible());a(abs(anchor()['paragraphIndex']-before['paragraphIndex'])<=1);exact(1)
 test('optional repeat cover preserves position',resume)
 def downloads():
  settings('downloads');p.locator('[data-download-check]').click();p.wait_for_function("document.querySelector('[data-download-status]').textContent.includes('86')");a(p.locator('[data-settings-panel=downloads]').is_visible());p.wait_for_function("document.querySelector('[data-download-volume]').textContent.includes('86 глав')");p.locator('[data-download-all]').click();p.wait_for_function('window.downloadLog?.includes(true)');close()
 test('download status and manual refresh (mock)',downloads)
 def resets():
  settings();p.locator('#setting-font-size').fill('26');p.wait_for_timeout(200);before=state()['currentChapterId'];p.locator('[data-settings-reset]').click();a(state()['readerSettings']['fontSize']==19);a(state()['currentChapterId']==before);a(state()['readerSettings']['theme']=='dark');p.locator('[data-art-setting=theme]').select_option('light');p.locator('#setting-font-size').fill('24');p.locator('[data-settings-tab=reading]').click();p.locator('[data-progress-reset]').click();route('contents');p.wait_for_timeout(350);a(state()['currentChapterId'] is None,str(state()));a(state()['readingAnchor'] is None);a(state()['readChapterIds']==[]);a(state()['readerSettings']['theme']=='light');a(state()['readerSettings']['fontSize']==24);a(p.locator('.chapter-entry.is-current').count()==0);a(p.locator('.chapter-entry.is-read').count()==0);p.wait_for_timeout(400);a(state()['currentChapterId'] is None)
 test('independent settings/progress resets',resets)
 def keyboard():
  if os.getenv('ECHO_KEYBOARD_ONLY')!='1':chapter(1)
  settings('reading');p.locator('select[data-reading-mode]').select_option('pages');close();p.locator('#reader-scroll').focus();before=geom()['current'];p.keyboard.press('ArrowRight');p.wait_for_timeout(400);a(geom()['current']==before+1,str((before,geom()['current'])));p.keyboard.press('ArrowLeft');p.wait_for_timeout(400);a(geom()['current']==before);p.keyboard.press('Enter');a(p.locator('#reader-screen').evaluate("e=>e.classList.contains('controls-visible')"));p.locator('[data-reader-settings]').focus();p.wait_for_timeout(4000);a(p.locator('[data-reader-settings]').evaluate("e=>Number(getComputedStyle(e.closest('.reader-toolbar')).opacity)>.9"));p.keyboard.press('Enter');route('settings');p.keyboard.press('Escape');route('reader');
 test('keyboard page turn and visible focus',keyboard)
 test('no JS errors or unexpected dialogs',lambda:a(not errs and len(dialogs)==2,str((errs,dialogs))))
 print(json.dumps({'width':W,'height':H,'pass':passed},ensure_ascii=False));b.close()
