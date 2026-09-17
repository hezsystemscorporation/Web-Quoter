// html.js — convert the generated Markdown subset to standalone HTML.
// Loaded via importScripts in the service worker.

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineHtml(s) {
  const codes = [];
  s = String(s).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0000C' + (codes.length - 1) + '\u0000'; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, a, u) => '<img src="' + u + '" alt="' + a + '">');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => '<a href="' + u + '">' + t + '</a>');
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\u0000C(\d+)\u0000/g, (m, i) => '<code>' + esc(codes[i]) + '</code>');
  return s;
}

function mdToHtml(md) {
  const lines = String(md).replace(/\r/g, '').split('\n');
  let html = '';
  let i = 0;
  const isBlock = (l) => /^(#{1,6}\s|```|>\s?|\s*([-*]|\d+\.)\s|---+$)/.test(l) || (/\|/.test(l));
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += '<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' + esc(buf.join('\n')) + '</code></pre>\n';
      continue;
    }
    if (/^---+$/.test(line.trim())) { html += '<hr>\n'; i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const l = h[1].length; html += '<h' + l + '>' + inlineHtml(h[2]) + '</h' + l + '>\n'; i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += '<blockquote>\n' + mdToHtml(buf.join('\n')) + '</blockquote>\n';
      continue;
    }
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const rows = [line]; i += 2;
      while (i < lines.length && /\|/.test(lines[i])) rows.push(lines[i++]);
      html += renderTable(rows);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const block = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) block.push(lines[i++]);
      html += renderList(block);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) para.push(lines[i++]);
    html += '<p>' + inlineHtml(para.join('\n')).replace(/\n/g, '<br>') + '</p>\n';
  }
  return html;
}

function renderList(lines) {
  let html = '';
  const stack = [];
  const close = (t) => (t.ordered ? '</ol>' : '</ul>');
  for (const line of lines) {
    const m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    const ordered = /\d/.test(m[2]);
    while (stack.length && indent < stack[stack.length - 1].indent) { html += '</li>' + close(stack.pop()); }
    if (!stack.length || indent > stack[stack.length - 1].indent) {
      html += ordered ? '<ol>' : '<ul>';
      stack.push({ indent, ordered });
      html += '<li>';
    } else {
      html += '</li><li>';
    }
    html += inlineHtml(m[3]);
  }
  while (stack.length) html += '</li>' + close(stack.pop());
  return html + '\n';
}

function renderTable(rows) {
  const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  let h = '<table>\n<thead>\n<tr>' + cells(rows[0]).map((c) => '<th>' + inlineHtml(c) + '</th>').join('') + '</tr>\n</thead>\n<tbody>\n';
  for (let i = 1; i < rows.length; i++) {
    h += '<tr>' + cells(rows[i]).map((c) => '<td>' + inlineHtml(c) + '</td>').join('') + '</tr>\n';
  }
  return h + '</tbody>\n</table>\n';
}

const HTML_CSS = 'body{max-width:820px;margin:40px auto;padding:0 16px;line-height:1.7;font-family:system-ui,"Segoe UI",sans-serif;color:#0f172a}' +
  'img{max-width:100%;height:auto}pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow:auto}' +
  'code{background:#f1f5f9;padding:1px 5px;border-radius:4px}pre code{background:none;padding:0}' +
  'table{border-collapse:collapse;width:100%}td,th{border:1px solid #cbd5e1;padding:6px 8px;text-align:left}' +
  'blockquote{border-left:4px solid #2563eb;margin:12px 0;padding-left:12px;color:#475569}' +
  '.src{color:#64748b;font-size:13px}';

function wrapHtmlDocument(bodyHtml, title, url, lang) {
  return '<!DOCTYPE html>\n<html lang="' + esc(lang || 'en') + '">\n<head>\n' +
    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>' + esc(title || '') + '</title>\n<style>' + HTML_CSS + '</style>\n</head>\n<body>\n' +
    '<header><p class="src">Source: <a href="' + esc(url || '') + '">' + esc(url || '') + '</a></p></header>\n' +
    bodyHtml + '\n</body>\n</html>\n';
}
