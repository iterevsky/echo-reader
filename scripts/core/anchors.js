// Preserve text: runtime IDs are metadata, not rewritten prose.
export function fingerprint(text) {
  let hash = 2166136261;
  for (const char of String(text).normalize('NFC')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function assignParagraphIds(article) {
  const paragraphs = [...article.querySelectorAll('p')];
  const counts = new Map();
  const used = new Set();
  for (const p of paragraphs) {
    const hash = fingerprint(p.textContent);
    const count = (counts.get(hash) || 0) + 1;
    counts.set(hash, count);
    const explicit = p.getAttribute('data-paragraph-id') || p.id;
    let id = explicit || `p-${hash}-${count}`;
    if (used.has(id)) {
      if (explicit) throw new Error('Повторяющийся идентификатор абзаца: ' + explicit);
      while (used.has(id)) id += '-x';
    }
    used.add(id);
    p.setAttribute('data-echo-anchor', id);
  }
  return paragraphs;
}

export function locateParagraph(paragraphs, anchor) {
  if (!anchor) return null;
  if (anchor.paragraphId) {
    const exact = paragraphs.find(p => p.getAttribute('data-echo-anchor') === anchor.paragraphId);
    if (exact) return exact;
  }
  if (anchor.quote) {
    const matches = paragraphs.filter(p => p.textContent.includes(anchor.quote));
    if (matches.length === 1) return matches[0];
  }
  return paragraphs[anchor.paragraphIndex] || null;
}

// v1 removed a title-like first sentence from the article. Translate its old
// paragraph index/offset to the unmodified source exactly once.
export function migrateLegacyAnchor(anchor, firstText, title) {
  if (!anchor || anchor.version === 2) return anchor;
  const next = { ...anchor, version: 2 };
  if (typeof title !== 'string' || !firstText.startsWith(title)) return next;
  const remainder = firstText.slice(title.length);
  const punctuation = remainder.match(/^[.!?…:;]+/)?.[0] || '';
  if (!punctuation) return next;
  const tail = remainder.slice(punctuation.length);
  const body = tail.replace(/^\s+/, '');
  if (!body) next.paragraphIndex += 1;
  else if (next.paragraphIndex === 0 && Number.isInteger(next.textOffset)) {
    next.textOffset += firstText.length - body.length;
  }
  return next;
}
