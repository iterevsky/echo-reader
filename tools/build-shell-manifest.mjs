import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const sw=await readFile(new URL('sw.js',root),'utf8');
const html=await readFile(new URL('index.html',root),'utf8');
const build=sw.match(/const BUILD_ID = '([^']+)'/)[1];
if(!html.includes(`name="echo-build" content="${build}"`))throw Error('Build ID differs between index and SW');
const list=[...sw.match(/const coreFiles = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);
const files=[];for(const file of list){const bytes=await readFile(new URL(file,root));files.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
await writeFile(new URL('data/shell-manifest.json',root),JSON.stringify({build,files},null,2)+'\n');
console.log(`Shell manifest: ${build}, ${files.length} files.`);
