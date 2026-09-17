// content.js — convert current selection to Markdown, collect image URLs.
(() => {
  const LOG = (...a) => console.log('[QMD content]', ...a);
  let styleCache = new WeakMap();
  const cs = (el) => {
    let s = styleCache.get(el);
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
    return s;
  };
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return null; } };
  const isBold = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.tagName === 'B' || n.tagName === 'STRONG') return true;
      if (parseInt(cs(n).fontWeight, 10) >= 600) return true;
    }
    return false;
  };
  const isItalic = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.tagName === 'I' || n.tagName === 'EM') return true;
      if (/^(italic|oblique)/.test(cs(n).fontStyle)) return true;
    }
    return false;
  };

  chrome.runtime.onMessage.addListener((msg, _snd, respond) => {
    if (msg && (msg.type === 'capture' || msg.type === 'capture-selection')) {
      styleCache = new WeakMap();
      const r = capture(msg.mode || 'selection');
      LOG('captured (' + (msg.mode || 'selection') + ')', r);
      respond(r);
    }
    return false;
  });

  function capture(mode) {
    let root;
    let range;
    if (mode === 'page') {
      root = document.body;
      if (!root) return { ok: false, error: 'NO_BODY' };
      range = document.createRange();
      range.selectNodeContents(root);
    } else {
      const sel = getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { ok: false, error: 'NO_SELECTION' };
      range = sel.getRangeAt(0);
      root = range.commonAncestorContainer;
      if (root.nodeType === Node.TEXT_NODE) root = root.parentElement;
      if (!root) return { ok: false, error: 'NO_SELECTION' };
    }
    const out = [];
    walkBlock(root, range, out);
    const markdown = out.filter((l) => l.trim()).join('\n\n').trim();
    const images = collectImageUrls(root, range);
    const links = collectLinkUrls(root, range);
    if (!markdown && !images.length && !links.length) return { ok: false, error: 'EMPTY_SELECTION' };
    return {
      ok: true,
      markdown,
      images,
      links,
      pageUrl: location.href,
      pageTitle: document.title || location.hostname
    };
  }

  // ---- block level ----
  const BLOCK_DISPLAY = /^(block|list-item|flow-root|table\b|flex|grid)/;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'FRAME', 'CANVAS', 'SVG', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'SELECT', 'TEXTAREA', 'DATALIST', 'MAP', 'AREA', 'FORM']);
  const isHidden = (el) => cs(el).display === 'none' || cs(el).visibility === 'hidden';
  const isSkipped = (el) => SKIP_TAGS.has(el.tagName) || isHidden(el);
  const isBlockLevel = (el) => BLOCK_DISPLAY.test(cs(el).display) || /^H[1-6]$/.test(el.tagName);
  const hasBlockChildEl = (el) => Array.from(el.children).some(isBlockLevel);

  function walkBlock(node, range, out) {
    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      const md = renderSegs(pending);
      if (md) out.push(md);
      pending = [];
    };
    for (const child of node.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && isSkipped(child)) continue;
      if (child.nodeType === Node.ELEMENT_NODE && isBlockLevel(child)) {
        flush();
        handleBlock(child, range, out);
      } else {
        collectInline(child, range, pending, {});
      }
    }
    flush();
  }

  function handleBlock(el, range, out) {
    const tag = el.tagName;
    if (!range.intersectsNode(el)) return;
    if (isSkipped(el)) return;
    if (tag === 'HR') { out.push('---'); return; }
    if (tag === 'IMG') {
      const segs = [];
      pushImg(el, segs);
      const md = renderSegs(segs);
      if (md) out.push(md);
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      const md = renderSegs(inlineOf(el, range));
      if (md) out.push('#'.repeat(+tag[1]) + ' ' + md.replace(/\n+/g, ' '));
      return;
    }
    if (tag === 'PRE') {
      const code = (el.innerText || el.textContent || '').replace(/\n+$/, '');
      const m = el.className.match(/language-([\w-]+)/);
      if (code.trim()) out.push('```' + (m ? m[1] : '') + '\n' + code + '\n```');
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      const sub = [];
      walkBlock(el, range, sub);
      if (sub.length) out.push(sub.join('\n\n').split('\n').map((l) => '> ' + l).join('\n'));
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      const sub = [];
      list(el, range, sub, tag === 'OL', '');
      if (sub.length) out.push(sub.join('\n'));
      return;
    }
    if (tag === 'TABLE') { table(el, range, out); return; }
    if (hasBlockChildEl(el)) walkBlock(el, range, out);
    else {
      const md = renderSegs(inlineOf(el, range));
      if (md) out.push(md);
    }
  }

  function list(el, range, out, ordered, indent) {
    let n = 0;
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      n++;
      if (!range.intersectsNode(li)) continue;
      const segs = [];
      const nested = [];
      for (const c of li.childNodes) {
        if (c.nodeType === Node.ELEMENT_NODE && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(c);
        else collectInline(c, range, segs, {});
      }
      const text = renderSegs(segs);
      if (text) out.push(indent + (ordered ? n + '. ' : '- ') + text.replace(/\n+/g, ' '));
      for (const sub of nested) list(sub, range, out, sub.tagName === 'OL', indent + '  ');
    }
  }

  function table(el, range, out) {
    const rows = Array.from(el.querySelectorAll('tr')).filter((tr) => range.intersectsNode(tr));
    if (!rows.length) return;
    const cell = (td) => renderSegs(inlineOf(td, range)).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
    const lines = rows.map((tr) => '| ' + Array.from(tr.children).map(cell).join(' | ') + ' |');
    const sep = '|' + Array.from(rows[0].children).map(() => ' --- ').join('|') + '|';
    out.push([lines[0], sep].concat(lines.slice(1)).join('\n'));
  }

  // ---- inline level ----
  function inlineOf(el, range) {
    const segs = [];
    for (const c of el.childNodes) collectInline(c, range, segs, {});
    return segs;
  }

  function collectInline(node, range, segs, ctx) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!range.intersectsNode(node)) return;
      let text = node.nodeValue;
      if (node === range.startContainer) text = text.slice(range.startOffset);
      if (node === range.endContainer) text = text.slice(0, range.endOffset);
      if (!text) return;
      const parent = node.parentElement || document.body;
      segs.push({ t: 'text', text, b: isBold(parent), i: isItalic(parent), code: ctx.code, link: ctx.link });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (!range.intersectsNode(node)) return;
    if (isSkipped(node)) return;
    const tag = node.tagName;
    if (tag === 'BR') { segs.push({ t: 'br' }); return; }
    if (tag === 'IMG') { pushImg(node, segs); return; }
    let c2 = ctx;
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') c2 = { code: true, link: ctx.link };
    if (tag === 'A' && !ctx.link) {
      const u = abs(node.getAttribute('href'));
      if (u) c2 = { code: ctx.code, link: u };
    }
    for (const c of node.childNodes) collectInline(c, range, segs, c2);
  }

  function pushImg(el, segs) {
    const url = abs(el.currentSrc || el.getAttribute('src') || el.getAttribute('data-src'));
    if (!url || url.startsWith('blob:')) return;
    segs.push({ t: 'img', url, alt: (el.alt || '').replace(/[[\]]/g, '') });
  }

  function renderSegs(segs) {
    // 1. tokens: merge adjacent same-style text, split on br/img
    const toks = [];
    for (const s of segs) {
      if (s.t === 'br') { toks.push({ k: 'br' }); continue; }
      if (s.t === 'img') { toks.push({ k: 'img', url: s.url, alt: s.alt }); continue; }
      const text = s.text.replace(/\s+/g, ' ');
      if (!text) continue;
      const last = toks[toks.length - 1];
      if (last && last.k === 't' && last.b === s.b && last.i === s.i && last.code === s.code && last.link === s.link) {
        last.text += text;
      } else {
        toks.push({ k: 't', text, b: s.b, i: s.i, code: s.code, link: s.link });
      }
    }
    // 2. merge adjacent text tokens whose styles are subset-related (bold + bold-italic ...)
    //    to avoid ambiguous runs like "*****"; only when the shared style is non-plain.
    const merged = [];
    for (const t of toks) {
      const p = merged[merged.length - 1];
      if (p && p.k === 't' && t.k === 't' && p.code === t.code && p.link === t.link) {
        const oB = p.b && t.b, oI = p.i && t.i;
        const pX = (p.b && !oB) || (p.i && !oI);
        const tX = (t.b && !oB) || (t.i && !oI);
        if ((oB || oI) && (!pX || !tX)) {
          const wrap = (x, b, i) => (b && i) ? '***' + x + '***' : b ? '**' + x + '**' : i ? '*' + x + '*' : x;
          const mid = /\s$/.test(p.text) || /^\s/.test(t.text) ? ' ' : '';
          const lead = /^\s/.test(p.text) ? ' ' : '';
          const trail = /\s$/.test(t.text) ? ' ' : '';
          p.text = lead + wrap(p.text.trim(), p.b && !oB, p.i && !oI) + mid +
                   wrap(t.text.trim(), t.b && !oB, t.i && !oI) + trail;
          p.b = oB; p.i = oI;
          continue;
        }
      }
      merged.push(t);
    }
    // 3. render
    let out = '';
    for (const t of merged) {
      if (t.k === 'br') { out += '\n'; continue; }
      if (t.k === 'img') { out += '![' + t.alt + '](' + t.url + ') '; continue; }
      const lead = t.text.startsWith(' ') ? ' ' : '';
      const trail = t.text.endsWith(' ') ? ' ' : '';
      let core = t.text.trim();
      if (!core) { out += ' '; continue; }
      if (t.code) core = '`' + core + '`';
      if (t.b && t.i) core = '***' + core + '***';
      else if (t.b) core = '**' + core + '**';
      else if (t.i) core = '*' + core + '*';
      if (t.link) core = '[' + core + '](' + t.link + ')';
      out += lead + core + trail;
    }
    return out.trim();
  }

  // ---- image url collection (incl. CSS background-image) ----
  function collectImageUrls(root, range) {
    const urls = new Set();
    const add = (u) => { if (u && !u.startsWith('blob:')) urls.add(u); };
    for (const img of root.querySelectorAll('img')) {
      if (!range.intersectsNode(img) || isHidden(img)) continue;
      add(abs(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src')));
    }
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!range.intersectsNode(el) || isSkipped(el)) continue;
      const bg = cs(el).backgroundImage;
      if (!bg || bg === 'none') continue;
      for (const m of bg.matchAll(/url\((["']?)([^"')]+)\1\)/g)) add(abs(m[2]));
    }
    return Array.from(urls);
  }

  // ---- link collection (attachment candidates resolved by background) ----
  function collectLinkUrls(root, range) {
    const urls = new Set();
    for (const a of [root, ...root.querySelectorAll('a[href]')]) {
      if (a.tagName !== 'A' || !range.intersectsNode(a) || isHidden(a)) continue;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || /^\s*javascript:/i.test(href)) continue;
      const u = abs(href);
      if (u && !u.startsWith('blob:')) urls.add(u);
    }
    return Array.from(urls);
  }
})();
