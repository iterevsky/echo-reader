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
  if os.getenv('ECHO_DOWNLOADS_ONLY')=='1':
   if name not in ['open chapter','consent denied','download status and manual refresh (mock)','no JS errors or unexpected dialogs']:return
   if name=='no JS errors or unexpected dialogs':a(not errs,str(errs));passed.append(name);print('PASS',name,flush=True);return
  f();passed.append(name);print('PASS',name,flush=True)
 def check(name,fn):
  fn();passed.append(name);print(f'PASS {W}: {name}',flush=True)
 def menu(which):
  p.locator('[data-edition-menu] summary').click();p.locator(f'[data-edition-menu] [data-info-open={which}]').click();route(which);p.locator(f'[data-info-page={which}]').wait_for(state='visible')
 def back():
  p.locator('.info-toolbar [data-info-back]').click();route('contents');p.locator('#contents-screen.is-active').wait_for();p.wait_for_timeout(100)
 def compare(which):
  a(p.locator(f'[data-info-page={which}] .info-prose p').all_text_contents()==(root/f'data/info/{which}.txt').read_text().strip().split('\n\n'))
 def nooverflow():
  a(p.locator('#info-scroll').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
 check('enter contents',enter)
 def geometry():
  g=p.evaluate("""()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {head:r('.contents-header').height,bar:r('.contents-range-bar').height,top:r('#contents-scroll').top,view:r('#contents-scroll').height,actions:r('.contents-actions').right,heading:r('.contents-heading').right,actionsLeft:r('.contents-actions').left,body:document.body.scrollWidth,range:document.querySelector('.contents-ranges').scrollWidth,rangeClient:document.querySelector('.contents-ranges').clientWidth}}"""); print('GEOM',g,flush=True);a(g['head']<=62 and g['bar']<=42 and g['top']<=110 and g['view']>=H-110,str(g));a(g['heading']<=g['actionsLeft'] and g['actions']<=W and g['body']<=W,str(g));a(g['range']<=g['rangeClient']+1,str(g));p.screenshot(path=f'/mnt/data/echo-rc2-contents-{W}.png')
 check('compact header and all ranges fit',geometry)
 def rangejump():
  for start in [26,51,76,1]:
   p.locator(f'[data-range-start="{start}"]').click();p.wait_for_timeout(850);a(p.locator(f'[data-range-start="{start}"]').get_attribute('aria-current')=='true',f'range {start}')
 check('all four range jumps and active range',rangejump)
 def density():
  p.locator('[data-density-menu] summary').click();p.locator('[data-density=compact]').click();a(state()['density']=='compact');a(not p.locator('[data-density-menu]').evaluate('e=>e.open'));a(p.locator('#contents-screen').get_attribute('data-density')=='compact')
 check('compact density menu',density)
 def globalsettings():
  p.locator('[data-contents-settings]').click();route('contents-settings');p.locator('[data-settings-backdrop].is-open').wait_for();p.wait_for_timeout(250)
 def globalclose():
  p.locator('[data-settings-close]').first.click();route('contents');p.wait_for_function('!document.querySelector("#contents-screen").inert');p.wait_for_timeout(150)
 def firstsettings():
  globalsettings();a(state()['currentChapterId'] is None);a(p.locator('#contents-screen').evaluate('e=>e.inert'));a(p.locator('[data-settings-density]').input_value()=='compact');p.locator('[data-settings-density]').select_option('spacious');p.locator('[data-art-setting=theme]').select_option('light');p.screenshot(path=f'/mnt/data/echo-rc2-settings-{W}.png');globalclose();a(state()['currentChapterId'] is None);a(state()['density']=='spacious');a(p.locator('#contents-screen').get_attribute('data-density')=='spacious');a(p.locator('[data-contents-settings]').evaluate('e=>e===document.activeElement'));p.screenshot(path=f'/mnt/data/echo-rc2-contents-light-{W}.png')
 check('settings before reading, theme, density and focus',firstsettings)
 def menus():
  p.locator('[data-edition-menu] summary').click();g=p.locator('[data-edition-menu] nav').bounding_box();a(g['x']>=0 and g['x']+g['width']<=W,str(g));p.screenshot(path=f'/mnt/data/echo-rc2-menu-{W}.png');p.keyboard.press('Escape');a(not p.locator('[data-edition-menu]').evaluate('e=>e.open'));menu('about');compare('about');nooverflow();back();menu('author');compare('author');nooverflow();back()
 check('menu fits and both literary texts exact',menus)
 def saved():
  p.locator('[data-range-start="1"]').click();p.wait_for_timeout(650);chapter(1);p.locator('[data-audio-choice=no]').click();p.wait_for_timeout(250);p.locator('#reader-scroll').evaluate('e=>e.scrollTop=e.scrollHeight*.55');p.wait_for_timeout(500);p.evaluate('history.back()');route('contents');p.wait_for_function('!document.querySelector("#contents-screen").inert');p.wait_for_timeout(250);before=state();globalsettings();p.locator('[data-art-setting=theme]').select_option('dark');p.locator('[data-settings-tab=reading]').click();p.locator('select[data-reading-mode]').select_option('pages');globalclose();after=state();a(all(before[k]==after[k] for k in ['currentChapterId','readingAnchor','readChapterIds']),str((before,after)));a(after['readerSettings']['readingMode']=='pages');chapter(1);exact(1);a(p.locator('#reader-screen').get_attribute('data-reading-mode')=='pages');p.evaluate('history.back()');route('contents');p.wait_for_function('!document.querySelector("#contents-screen").inert')
 check('settings from contents preserve chapter and exact anchor',saved)
 def hist():
  globalsettings();p.keyboard.press('Escape');route('contents');p.wait_for_function('!document.querySelector("#contents-screen").inert');p.evaluate('history.forward()');route('contents-settings');p.locator('[data-settings-backdrop].is-open').wait_for();globalclose()
 check('Escape, history forward and close',hist)
 def reset():
  globalsettings();p.locator('[data-settings-tab=reading]').click();p.locator('[data-progress-reset]').click();route('contents');p.wait_for_function('!document.querySelector("#contents-screen").inert');a(state()['currentChapterId'] is None);a(state()['readerSettings']['readingMode']=='pages');a(state()['readChapterIds']==[])
 check('reset from contents keeps preferences',reset)
 check('no unexpected JS errors',lambda:a(not errs,str(errs)))
 print(json.dumps({'width':W,'height':H,'pass':passed},ensure_ascii=False));b.close()
