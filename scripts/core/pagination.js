import { locateParagraph, resolveReadingOffset } from './anchors.js';

// CSS columns preserve the original DOM, including inline formatting.
export function createPagination(viewport, article, text) {
  let page = 0, count = 1, stride = 1, retained = null, animation = null;
  const paragraphs = () => [...text.querySelectorAll('p')];
  function stop() { animation?.cancel(); animation = null; }
  function nodes(p) {
    const result = [], walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) if (node.length) result.push(node);
    return result;
  }
  function charPage(node, offset) {
    const range = document.createRange();
    const i = Math.max(0, Math.min(node.length - 1, offset));
    range.setStart(node, i); range.setEnd(node, i + 1);
    const rect = range.getClientRects()[0];
    if (!rect) return 0;
    return Math.max(0, Math.floor((rect.left - article.getBoundingClientRect().left + 0.5) / stride));
  }
  function pageFor(anchor) {
    if (!anchor || anchor.atStart) return 0;
    const p = locateParagraph(paragraphs(), anchor);
    if (!p) return 0;
    let offset = resolveReadingOffset(p.textContent, anchor);
    if (offset === null) offset = Math.floor(p.textContent.length * (anchor.paragraphRatio || 0));
    const list = nodes(p);
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (offset < node.length || i === list.length - 1) return charPage(node, offset);
      offset -= node.length;
    }
    return 0;
  }
  function place(target, style = 'none') {
    stop();
    const previous = page;
    page = Math.max(0, Math.min(count - 1, target));
    const transform = n => `translateX(${-n * stride}px)`;
    article.style.transform = transform(page);
    viewport.scrollLeft = 0;
    if (previous === page || style === 'none' || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !article.animate) return;
    animation = article.animate(style === 'fade' ? [{opacity: .15}, {opacity: 1}] :
      [{transform: transform(previous)}, {transform: transform(page)}],
      {duration: style === 'fade' ? 220 : 260, easing: 'ease-out'});
  }
  function layout(anchor, atEnd = false) {
    stop();
    article.style.transform = 'none';
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
    const css = getComputedStyle(viewport);
    const height = Math.max(1, Math.floor(viewport.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom)));
    const width = article.getBoundingClientRect().width;
    stride = viewport.clientWidth;
    article.style.setProperty('--page-height', `${height}px`);
    article.style.setProperty('--page-gap', `${Math.max(0, stride - width)}px`);
    const list = paragraphs();
    count = 1;
    // The last rendered character determines the last page; trailing margins do not.
    for (const p of list) {
      const ns = nodes(p);
      if (ns.length) count = Math.max(count, charPage(ns.at(-1), ns.at(-1).length - 1) + 1);
    }
    retained = atEnd ? null : anchor;
    place(atEnd ? count - 1 : pageFor(anchor));
  }
  function capture() {
    if (retained) return retained;
    const list = paragraphs();
    for (let pi = 0; pi < list.length; pi++) {
      const p = list[pi]; let offset = 0;
      for (const node of nodes(p)) {
        if (charPage(node, node.length - 1) >= page) {
          let lo = 0, hi = node.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (charPage(node, mid) < page) lo = mid + 1; else hi = mid;
          }
          const textOffset = offset + lo;
          return {version: 2, atStart: page === 0, paragraphIndex: pi,
            paragraphId: p.getAttribute('data-echo-anchor'), textOffset,
            quote: p.textContent.slice(Math.max(0, textOffset - 20), textOffset + 80),
            quoteOffset: Math.min(20, textOffset),
            paragraphRatio: textOffset / Math.max(1, p.textContent.length), viewportOffset: 24};
        }
        offset += node.length;
      }
    }
    return null;
  }
  function turn(delta, style) {
    const target = page + delta;
    if (target < 0 || target >= count) return false;
    retained = null; place(target, style); return true;
  }
  function disable() {
    stop(); retained = null; page = 0; count = 1;
    article.style.removeProperty('transform');
    article.style.removeProperty('--page-height');
    article.style.removeProperty('--page-gap');
    viewport.scrollLeft = 0;
  }
  return {layout, capture, turn, disable, stop, atEnd: () => page === count - 1};
}
