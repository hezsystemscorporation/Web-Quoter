// options.js — global settings: language, filename template, attachments, dedup.
const $ = (id) => document.getElementById(id);
let lang = 'en';
let customized = false; // true when user saved a non-empty custom template

chrome.storage.local.get(['filename_tpl', 'download_attachments', 'on_duplicate', 'ui_lang'], (r) => {
  lang = I18N[r.ui_lang] ? r.ui_lang : detectLang();
  customized = !!r.filename_tpl;
  $('tpl').value = r.filename_tpl || tr(lang, 'default_tpl');
  $('att').checked = r.download_attachments !== false;
  document.querySelector('input[name=dup][value=' + (r.on_duplicate === 'rename' ? 'rename' : 'skip') + ']').checked = true;
  applyLang();
});

function applyLang() {
  document.documentElement.lang = lang;
  document.title = 'Web Quoter';
  document.querySelectorAll('[data-i]').forEach((el) => { el.textContent = tr(lang, el.dataset.i); });
  // keep template box in sync with the language default unless customized/edited
  $('tpl').placeholder = tr(lang, 'default_tpl');
  if (!customized && !$('tpl').dataset.dirty) $('tpl').value = tr(lang, 'default_tpl');
  const box = $('langs');
  box.innerHTML = '';
  for (const code of I18N_LANGS) {
    const b = document.createElement('button');
    b.className = 'lang';
    b.textContent = I18N_NATIVE[code];
    b.setAttribute('aria-pressed', String(code === lang));
    b.onclick = () => {
      lang = code;
      chrome.storage.local.set({ ui_lang: code }, applyLang);
    };
    box.appendChild(b);
  }
  preview();
}

$('save').onclick = () => {
  const dup = document.querySelector('input[name=dup]:checked');
  const val = $('tpl').value.trim();
  // empty or equal to the language default => not customized (follows language)
  const storeTpl = (!val || val === tr(lang, 'default_tpl')) ? '' : val;
  customized = !!storeTpl;
  delete $('tpl').dataset.dirty;
  chrome.storage.local.set({
    filename_tpl: storeTpl,
    download_attachments: $('att').checked,
    on_duplicate: dup ? dup.value : 'skip'
  }, () => {
    $('status').textContent = tr(lang, 'txt_saved');
    setTimeout(() => { $('status').textContent = ''; }, 1500);
  });
};

$('reset').onclick = () => {
  customized = false;
  delete $('tpl').dataset.dirty;
  $('tpl').value = tr(lang, 'default_tpl');
  $('att').checked = true;
  document.querySelector('input[name=dup][value=skip]').checked = true;
  chrome.storage.local.remove(['filename_tpl', 'download_attachments', 'on_duplicate'], preview);
};

$('tpl').addEventListener('input', () => { $('tpl').dataset.dirty = '1'; preview(); });

document.querySelectorAll('.ins').forEach((b) => {
  b.onclick = () => {
    const el = $('tpl');
    const s = el.selectionStart;
    el.value = el.value.slice(0, s) + b.dataset.t + el.value.slice(el.selectionEnd);
    el.selectionStart = el.selectionEnd = s + b.dataset.t.length;
    el.focus();
    el.dataset.dirty = '1';
    preview();
  };
});

function preview() {
  const fake = {
    pageUrl: 'https://news.ycombinator.com/item?id=12345',
    pageTitle: 'Show HN: A Great Article'
  };
  $('preview').textContent = tr(lang, 'lbl_preview') + ': ' + buildFilename($('tpl').value.trim() || tr(lang, 'default_tpl'), fake) + '.zip';
}

// mirror of background.js buildFilename (kept in sync)
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
