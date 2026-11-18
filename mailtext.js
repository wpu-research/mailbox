// Liste önizlemesi (snippet) için yardımcılar: bodyStructure'dan uygun parçayı seç,
// aktarım kodlamasını (base64 / quoted-printable) ve karakter setini çöz, HTML'i düz metne indir.
import iconv from 'iconv-lite';
import * as libqp from 'libqp';
import he from 'he';

const PLAIN_MAX = 4096, HTML_MAX = 32768;

// Düz metin (yoksa HTML) gövde parçasını bul. Ek (attachment) olanlar atlanır.
export function pickPart(root) {
  let plain = null, html = null;
  (function walk(n) {
    if (!n || (plain && html)) return;
    if (n.childNodes?.length) { n.childNodes.forEach(walk); return; }
    if (/attachment/i.test(n.disposition || '')) return;
    const type = String(n.type || '').toLowerCase();
    const info = { part: n.part || '1', encoding: String(n.encoding || '7bit').toLowerCase(), charset: n.parameters?.charset || 'utf-8', type };
    if (type === 'text/plain' && !plain) plain = info;
    else if (type === 'text/html' && !html) html = info;
  })(root);
  const p = plain || html;
  return p ? { ...p, max: p.type === 'text/html' ? HTML_MAX : PLAIN_MAX } : null;
}

export function decodePart(buf, encoding, charset) {
  let b = buf;
  if (encoding === 'quoted-printable') b = libqp.decode(buf.toString('binary'));
  else if (encoding === 'base64') b = Buffer.from(buf.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  const cs = String(charset || 'utf-8').toLowerCase();
  try { return iconv.encodingExists(cs) ? iconv.decode(b, cs) : b.toString('utf8'); } catch { return b.toString('utf8'); }
}

export function htmlToText(html) {
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!--[\s\S]*$/, ' ')
    .replace(/<(head|style|script|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(head|style|script|title)\b[\s\S]*$/gi, ' ')   // kesilmiş, kapanmamış blok
    .replace(/<\/?(br|p|div|tr|li|h[1-6]|table|td)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/<[^>]*$/, ' ');                                   // kesilmiş etiket
  s = he.decode(s);
  return s.replace(/[​-‏­͏⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
}

export function snippetFromPart(buf, info, len = 200) {
  if (!buf || !info) return '';
  let t = decodePart(buf, info.encoding, info.charset);
  if (info.type === 'text/html') t = htmlToText(t);
  else t = t.replace(/[​-‏­͏﻿]/g, '').replace(/\s+/g, ' ').trim();
  return t.slice(0, len);
}
