import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = resolve(projectRoot, 'data/chapters.json');
const manifestPath = resolve(projectRoot, 'data/chapters-manifest.json');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const catalogBytes = await readFile(catalogPath);
const catalog = JSON.parse(catalogBytes.toString('utf8'));

if (catalog.version !== 1 || !Array.isArray(catalog.chapters) || catalog.chapters.length === 0) {
  throw new Error('data/chapters.json has an unsupported or empty structure.');
}

const ids = new Set();
const numbers = new Set();
const chapters = [];

for (const chapter of catalog.chapters) {
  if (
    typeof chapter.id !== 'string' ||
    !Number.isInteger(chapter.number) ||
    typeof chapter.file !== 'string' ||
    !/^data\/chapters\/[0-9]{3}\.html$/.test(chapter.file)
  ) {
    throw new Error(`Invalid chapter record: ${JSON.stringify(chapter)}`);
  }
  if (ids.has(chapter.id) || numbers.has(chapter.number)) {
    throw new Error(`Duplicate chapter id or number: ${chapter.id}`);
  }
  ids.add(chapter.id);
  numbers.add(chapter.number);

  const bytes = await readFile(resolve(projectRoot, chapter.file));
  chapters.push({
    id: chapter.id,
    number: chapter.number,
    file: chapter.file,
    sha256: sha256(bytes),
    bytes: bytes.byteLength
  });
}

const catalogSha256 = sha256(catalogBytes);
const versionSource = `${catalogSha256}\n${chapters.map((chapter) => `${chapter.id}:${chapter.sha256}`).join('\n')}`;
const contentVersion = sha256(Buffer.from(versionSource, 'utf8')).slice(0, 20);

const manifest = {
  schemaVersion: 1,
  contentVersion,
  catalogSha256,
  chapterCount: chapters.length,
  totalBytes: chapters.reduce((sum, chapter) => sum + chapter.bytes, 0),
  chapters
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Content manifest written: ${chapters.length} chapters, version ${contentVersion}.`);
