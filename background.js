// background.js (MV3 service worker) — orchestrate capture, fetch, ZIP/MD/HTML build, download.
importScripts('i18n.js');
importScripts('html.js');
const LOG = (...a) => console.log('[QMD bg]', ...a);

const defaultTpl = (lang) => tr(lang, 'default_tpl');

// menu id -> {mode, format}
const ACTIONS = {
  'qmd-sel-md': { mode: 'selection', format: 'md' },
  'qmd-sel-html': { mode: 'selection', format: 'html' },
  'qmd-sel-media': { mode: 'selection', format: 'media' },
  'qmd-page-md': { mode: 'page', format: 'md' },
  'qmd-page-html': { mode: 'page', format: 'html' }
};

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  makeMenu(s.ui_lang);
  LOG('installed, lang', s.ui_lang);
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.ui_lang) makeMenu(ch.ui_lang.newValue);
});

function makeMenu(lang) {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'qmd-sel', title: tr(lang, 'menu_group_sel'), contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'qmd-sel-md', parentId: 'qmd-sel', title: tr(lang, 'menu_sel_md'), contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'qmd-sel-html', parentId: 'qmd-sel', title: tr(lang, 'menu_sel_html'), contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'qmd-sel-media', parentId: 'qmd-sel', title: tr(lang, 'menu_sel_media'), contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'qmd-page', title: tr(lang, 'menu_group_page'), contexts: ['page'] });
    chrome.contextMenus.create({ id: 'qmd-page-md', parentId: 'qmd-page', title: tr(lang, 'menu_page_md'), contexts: ['page'] });
    chrome.contextMenus.create({ id: 'qmd-page-html', parentId: 'qmd-page', title: tr(lang, 'menu_page_html'), contexts: ['page'] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const action = ACTIONS[info.menuItemId];
  if (!action || !tab || !tab.id) return;
  let lang = detectLang();
  try {
    lang = (await getSettings()).ui_lang;
    await run(tab, action, lang);
  } catch (e) {
    const m = (e && e.message) || String(e);
    LOG('failed', e);
    if (/receiving end|Could not establish/i.test(m)) notify(lang, 'notif_reload');
    else notify(lang, 'notif_failed', m);
  }
});

function notify(lang, key, extra) {
  const msg = tr(lang, key) + (extra || '');
  LOG('notify:', msg);
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Web Quoter',
    message: msg
  });
}

async function run(tab, action, lang) {
  LOG('capture start, tab', tab.id, action);
  const cap = await chrome.tabs.sendMessage(tab.id, { type: 'capture', mode: action.mode });
  if (!cap || !cap.ok) {
    LOG('capture failed:', cap && cap.error);
    notify(lang, 'notif_no_content');
    return;
  }
  const settings = await getSettings();
  const base = buildFilename(settings.filename_tpl || defaultTpl(settings.ui_lang), cap);
  const { media, textFile, notDownloaded } = await buildPackage(cap, base, settings, action.format);
  const enc = new TextEncoder();
  const files = media.slice();
  if (notDownloaded.length) {
    files.push({ name: 'link_not_downloaded.txt', data: enc.encode(notDownloadedText(notDownloaded)) });
    LOG('links not downloaded:', notDownloaded.length);
  }
  let dl;
  if (action.format === 'media') {
    if (!files.length) { notify(lang, 'notif_no_media'); return; }
    dl = zipDownload(base + '.zip', files);
  } else {
    files.push(textFile);
    if (media.length === 0 && notDownloaded.length === 0) {
      // text-only: save the plain .md/.html file, no ZIP wrapper
      const mime = action.format === 'html' ? 'text/html' : 'text/markdown';
      dl = { url: 'data:' + mime + ';charset=utf-8;base64,' + toB64(textFile.data), filename: textFile.name };
    } else {
      dl = zipDownload(base + '.zip', files);
    }
  }
  const id = await chrome.downloads.download(Object.assign({ saveAs: false }, dl));
  LOG('download started:', dl.filename, 'id', id);
}

function zipDownload(filename, files) {
  const zip = zipSync(files);
  LOG('zip built,', zip.length, 'bytes,', files.length, 'entries');
  return { url: 'data:application/zip;base64,' + toB64(zip), filename };
}

function notDownloadedText(list) {
  return 'URL\tREASON\n' + list.map((x) => x.url + '\t' + x.reason).join('\n') + '\n';
}

// ---- settings ----
async function getSettings() {
  const d = { filename_tpl: '', download_attachments: true, on_duplicate: 'skip', ui_lang: detectLang() };
  try {
    const s = await chrome.storage.local.get(['filename_tpl', 'download_attachments', 'on_duplicate', 'ui_lang']);
    for (const k in d) if (s[k] !== undefined) d[k] = s[k];
  } catch (e) { LOG('storage read failed, defaults used:', e.message); }
  // empty template = not customized -> follow UI language
  if (!d.filename_tpl) d.filename_tpl = defaultTpl(d.ui_lang);
  return d;
}

// ---- package: fetch images + attachments, dedup, rewrite md, build text file ----
// Returns { media: [entries], textFile: {name,data}|null, notDownloaded: [{url,reason}] }
async function buildPackage(cap, base, settings, format) {
  const enc = new TextEncoder();
  let md = cap.markdown || '';
  const wantText = format === 'md' || format === 'html';
  const media = [];
  const notDownloaded = [];
  const st = {
    files: media,
    hashToPath: new Map(),
    usedNames: new Set(),
    onDuplicate: settings.on_duplicate === 'rename' ? 'rename' : 'skip'
  };
  const bgOnly = [];
  const imageUrls = new Set(cap.images || []);

  // images
  let n = 0;
  for (const src of cap.images || []) {
    let got;
    try { got = await grabImage(src); }
    catch (e) { LOG('image failed:', src, e.message); notDownloaded.push({ url: src, reason: 'IMAGE_FAILED: ' + e.message }); continue; }
    n++;
    const local = await registerFile(got.bytes, 'images/img_' + String(n).padStart(3, '0') + '.' + got.ext, st);
    if (wantText) {
      if (md.includes(src)) md = md.split(src).join(local);
      else if (bgOnly.indexOf(local) < 0) bgOnly.push(local);
    }
    LOG('image saved:', src, '->', local, got.bytes.length, 'bytes');
  }

  // attachments: links resolving to downloadable files (redirects / view pages parsed).
  // Non-file links and failed resolutions keep their web access URL in the text;
  // media-only mode records every link that could not be saved as a file.
  let a = 0;
  const tryAttachments = format === 'media' || settings.download_attachments;
  if (tryAttachments) {
    for (const src of cap.links || []) {
      if (imageUrls.has(src)) continue; // image links are handled above, not as attachments
      if (!isAttachmentUrl(src)) {
        if (format === 'media') notDownloaded.push({ url: src, reason: 'NOT_A_FILE' });
        continue; // md/html: keep access URL as-is
      }
      let got;
      try { got = await resolveAttachment(src); }
      catch (e) { LOG('keep access link (not a downloadable file):', src, e.message); notDownloaded.push({ url: src, reason: 'LINK_FAILED: ' + e.message }); continue; }
      a++;
      const clean = sanitizeFileName(got.name);
      const desired = 'attachments/' + (clean && /\.[\w-]+$/.test(clean) ? clean : (clean || 'attachment_' + a) + '.' + got.ext);
      const local = await registerFile(got.bytes, desired, st);
      if (wantText && md.includes(src)) md = md.split(src).join(local);
      LOG('attachment saved:', src, '->', local, got.bytes.length, 'bytes');
    }
  }

  let textFile = null;
  if (wantText) {
    if (bgOnly.length) {
      md += '\n\n## ' + tr(settings.ui_lang || 'en', 'heading_bg') + '\n\n' + bgOnly.map((p) => '![](' + p + ')').join('\n');
    }
    textFile = format === 'html'
      ? { name: base + '.html', data: enc.encode(wrapHtmlDocument(mdToHtml(md), cap.pageTitle, cap.pageUrl, settings.ui_lang)) }
      : { name: base + '.md', data: enc.encode(md + '\n') };
  }
  LOG('package:', n, 'images,', a, 'attachments,', notDownloaded.length, 'not-downloaded, format', format);
  return { media, textFile, notDownloaded };
}

async function grabImage(src) {
  if (src.startsWith('data:')) {
    const m = src.match(/^data:([^;,]*)[;,]/);
    return { bytes: b64ToBytes(atob(src.slice(src.indexOf(',') + 1))), ext: extFromMime(m && m[1]) || 'png' };
  }
  const res = await fetchWithTimeout(src, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    ext: extFromMime(mime) || extFromUrl(src) || 'jpg'
  };
}

// ---- attachment detection & lazy-link resolution (e.g. Moodle view.php) ----
const FILE_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|tgz|bz2|tar|epub|mobi|txt|md|csv|rtf|od[tpg]|xml|json|ipynb|py|java|c|cc|cpp|h|hpp|js|ts|sql|log|tex|bib|exe|msi|dmg|apk|iso|wav|mp3|m4a|flac|ogg|mp4|mkv|avi|mov|webm|flv)([?#]|$)/i;
const RESOURCE_RE = /(\/mod\/(resource|file|forum|assign)\/|pluginfile\.php|file\.php\?|content\.php|forcedownload=1|\/download\/|\/attachments?\/|action=download|[?&](download|file|filename)=)/i;

function isAttachmentUrl(u) {
  if (u.startsWith('data:') || u.startsWith('blob:')) return false;
  return FILE_EXT_RE.test(u) || RESOURCE_RE.test(u);
}

async function resolveAttachment(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetchWithTimeout(url, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    url = res.url || url;
    const ctype = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'text/html' && ctype !== 'application/xhtml+xml') {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) throw new Error('EMPTY RESPONSE');
      return {
        bytes,
        name: nameFromResponse(res, url),
        ext: extFromMimeFull(ctype) || extFromUrlAny(url) || extFromUrlAny(startUrl) || 'bin'
      };
    }
    const cand = findFileLink(await res.text(), url);
    if (!cand) throw new Error('NO_FILE_LINK_IN_PAGE');
    url = cand;
  }
  throw new Error('REDIRECT_LIMIT');
}

function findFileLink(html, base) {
  const cands = [];
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) cands.push(m[1]);
  for (const m of html.matchAll(/url=([^"'&>\s]+)/gi)) cands.push(m[1]);
  let best = null, bestScore = 1;
  for (let u of cands) {
    if (/^\s*javascript:/i.test(u)) continue;
    try { u = new URL(u, base).href; } catch { continue; }
    let s = 0;
    if (FILE_EXT_RE.test(u)) s += 3;
    if (RESOURCE_RE.test(u)) s += 2;
    if (s > bestScore) { best = u; bestScore = s; }
  }
  return best;
}

function nameFromResponse(res, url) {
  const cd = res.headers.get('content-disposition') || '';
  let m = cd.match(/filename\*\s*=\s*[^;]*'[^']*'([^;"]+)/i) || cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (m) { try { return decodeURIComponent(m[1].trim()); } catch { return m[1].trim(); } }
  try {
    const b = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (b) { try { return decodeURIComponent(b); } catch { return b; } }
  } catch { /* noop */ }
  return '';
}

function sanitizeFileName(name) {
  return (name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').replace(/^\.+|\.+$/g, '').slice(0, 120).trim();
}

// ---- dedup: content hash -> path ----
async function sha256Hex(bytes) {
  try {
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

async function registerFile(bytes, desired, st) {
  const hash = await sha256Hex(bytes);
  const prev = hash ? st.hashToPath.get(hash) : null;
  if (prev) {
    if (st.onDuplicate === 'skip') { LOG('duplicate skipped:', desired, '==', prev); return prev; }
    desired = prev; // rename mode: derive a copy name from the saved original
  }
  const path = uniqueName(desired, st.usedNames);
  if (hash) st.hashToPath.set(hash, path);
  st.files.push({ name: path, data: bytes });
  return path;
}

function uniqueName(path, set) {
  if (!set.has(path)) { set.add(path); return path; }
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const ext = dot > slash ? path.slice(dot) : '';
  const stem = dot > slash ? path.slice(0, dot) : path;
  let i = 2, cand;
  do { cand = stem + ' (' + i + ')' + ext; i++; } while (set.has(cand));
  set.add(cand);
  return cand;
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 20000);
  try {
    return await fetch(url, Object.assign({ redirect: 'follow' }, opts, { signal: ctrl.signal }));
  } finally { clearTimeout(timer); }
}

function buildFilename(tpl, cap) {
  const vals = {
    '{site}': siteSlug(cap.pageUrl),
    '{url}': cap.pageUrl.replace(/[^-\w.]/g, '_'),
    '{title}': (cap.pageTitle || 'untitled').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60),
    '{time}': timestamp(),
    '{date}': timestamp().split(' ')[0],
    '{datetime}': timestamp().replace(/：/g, '-').replace(/ /g, '_')
  };
  let name = tpl;
  for (const k in vals) name = name.split(k).join(vals[k]);
  name = name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  return name || vals['{site}'];
}

function timestamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  // full-width colon keeps the filename valid on Windows/macOS
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + '：' + p(d.getMinutes()) + '：' + p(d.getSeconds());
}

function siteSlug(href) {
  let u;
  try { u = new URL(href); } catch { return 'page'; }
  let s = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname) + (u.search || '');
  s = s.replace(/[\\/:*?"<>|#%&=+?\s]/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return s.slice(0, 80) || 'page';
}

// ---- zip (STORE, no compression; UTF-8 names) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

function zipSync(files) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true);
    lh.setUint32(22, f.data.length, true);
    lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, f.data.length, true);
    ch.setUint32(24, f.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  parts.push(...central, new Uint8Array(eocd.buffer));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

// ---- helpers ----
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extFromMime(mime) {
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif',
    'image/tiff': 'tif', 'image/x-icon': 'ico'
  };
  return map[mime] || null;
}

function extFromUrl(url) {
  const m = url.match(/\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?|ico)(\?|#|$)/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg').replace('tiff', 'tif') : null;
}

function extFromUrlAny(url) {
  const m = url.match(FILE_EXT_RE);
  return m ? m[1].toLowerCase() : null;
}

function extFromMimeFull(mime) {
  const map = {
    'application/pdf': 'pdf', 'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/zip': 'zip', 'application/x-rar-compressed': 'rar', 'application/x-7z-compressed': '7z',
    'application/gzip': 'gz', 'application/x-tar': 'tar', 'application/epub+zip': 'epub',
    'text/plain': 'txt', 'text/csv': 'csv', 'text/markdown': 'md',
    'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
    'video/mp4': 'mp4', 'video/webm': 'webm'
  };
  return map[mime] !== undefined ? map[mime] : extFromMime(mime);
}

LOG('service worker loaded');
