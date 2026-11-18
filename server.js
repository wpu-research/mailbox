import express from 'express';
import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPart, snippetFromPart } from './mailtext.js';

const HOST = process.env.MAIL_HOST || 'mail.kurumsaleposta.com';
const IMAP_PORT = +(process.env.IMAP_PORT || 993);
const SMTP_PORT = +(process.env.SMTP_PORT || 465);
const TTL = 8 * 3600e3;

// Şifre diske/env'e yazılmaz: yalnız oturum süresince bellekte tutulur.
const sessions = new Map();
const fails = new Map();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

const sid = req => (req.headers.cookie || '').match(/sid=([a-f0-9]{64})/)?.[1];
function auth(req, res, next) {
  const s = sessions.get(sid(req));
  if (!s || Date.now() - s.t > TTL) return res.status(401).json({ error: 'Oturum yok' });
  req.s = s; next();
}
async function imap(s, fn) {
  const c = new ImapFlow({ host: HOST, port: IMAP_PORT, secure: true, auth: { user: s.user, pass: s.pass }, logger: false });
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => {}); }
}

app.post('/api/login', async (req, res) => {
  const ip = req.ip, f = fails.get(ip) || { n: 0, t: 0 };
  if (f.n >= 5 && Date.now() - f.t < 15 * 60e3) return res.status(429).json({ error: 'Çok fazla deneme, 15 dk bekleyin' });
  const { user, pass } = req.body || {};
  try {
    await imap({ user, pass }, async () => {});
    const id = crypto.randomBytes(32).toString('hex');
    sessions.set(id, { user, pass, t: Date.now() });
    fails.delete(ip);
    res.setHeader('Set-Cookie', `sid=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}`);
    res.json({ ok: true, user });
  } catch {
    fails.set(ip, { n: f.n + 1, t: Date.now() });
    res.status(401).json({ error: 'Giriş başarısız' });
  }
});

app.post('/api/logout', (req, res) => { sessions.delete(sid(req)); res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/'); res.json({ ok: true }); });

app.get('/api/me', auth, (req, res) => res.json({ user: req.s.user }));

// ---------- Yardımcılar ----------
const VIRT_STARRED = '__starred';
const VK = '__kind:';              // var olmayan standart klasör yer tutucusu: __kind:sent
const uidList = v => Array.isArray(v) ? [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 500) : [];
const ah = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });

function hasAtt(n) {
  if (!n) return false;
  if (n.disposition && /attachment/i.test(n.disposition)) return true;
  if (n.childNodes?.length) return n.childNodes.some(hasAtt);
  return false;
}

// Standart klasörler: specialUse bayrağı VEYA ad sezgisi (Türkçe/İngilizce, "INBOX." öneki atılır).
const KINDS = {
  sent:    { flag: '\\Sent',    create: 'Sent',    re: /^(sent|sent items|sent messages|sent mail|gonderilen.*|gonderilmis.*)$/ },
  drafts:  { flag: '\\Drafts',  create: 'Drafts',  re: /^(drafts?|draft messages|taslak.*)$/ },
  junk:    { flag: '\\Junk',    create: 'Junk',    re: /^(junk|junk e-?mail|junk mail|spam|bulk mail|gereksiz.*)$/ },
  trash:   { flag: '\\Trash',   create: 'Trash',   re: /^(trash|bin|deleted|deleted items|deleted messages|cop|cop kutusu|silinen.*|silinmis.*)$/ },
  archive: { flag: '\\Archive', create: 'Archive', re: /^(archives?|arsiv.*)$/ },
};
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').toLowerCase().trim();
const lastSeg = f => String(f.name || f.path).split(f.delimiter || '/').pop();
const isInbox = f => f.path.toUpperCase() === 'INBOX';
const usable = f => !(f.flags?.has('\\Noselect') || f.flags?.has('\\NonExistent'));

// Her klasöre special ata; her tür için tek klasör (önce bayrak, sonra ad sezgisi).
function classify(all) {
  const out = new Map(), taken = new Set();
  for (const f of all) {
    if (isInbox(f)) { out.set(f.path, '\\Inbox'); continue; }
    if (!usable(f)) continue;
    const k = Object.keys(KINDS).find(k => KINDS[k].flag === f.specialUse && !taken.has(k));
    if (k) { out.set(f.path, k); taken.add(k); }
  }
  for (const f of all) {
    if (isInbox(f) || !usable(f) || out.has(f.path)) continue;
    const n = norm(lastSeg(f)), k = Object.keys(KINDS).find(k => !taken.has(k) && KINDS[k].re.test(n));
    if (k) { out.set(f.path, k); taken.add(k); }
  }
  return out;
}
// Tek yardımcı: standart klasörü bul; yoksa create=true ise oluştur. Gönder/arşivle/sil/taslak hepsi bunu kullanır.
async function resolveSpecial(c, kind, create = false) {
  let all = await c.list();
  let hit = [...classify(all)].find(([, k]) => k === kind);
  if (hit) return { path: hit[0] };
  if (!create) return null;
  const inbox = all.find(isInbox), d = inbox?.delimiter || '/';
  // Sunucu "INBOX.Sent" biçimindeyse (cPanel/Dovecot) aynı ad alanı kullanılır.
  const prefix = all.some(f => f.path.toUpperCase().startsWith('INBOX' + d)) ? 'INBOX' + d : '';
  const p = prefix + KINDS[kind].create;
  await c.mailboxCreate(p).catch(() => {});
  await c.mailboxSubscribe(p).catch(() => {});
  all = await c.list();
  hit = [...classify(all)].find(([, k]) => k === kind);
  return { path: hit ? hit[0] : p };
}
// İstemciden gelen klasör adını gerçek yola çevir (yer tutucu → standart klasör; yoksa null).
async function resolveFolder(c, f, create = false) {
  if (!f || f === VIRT_STARRED) return 'INBOX';
  f = String(f);
  if (f.startsWith(VK)) { const k = f.slice(VK.length); return KINDS[k] ? (await resolveSpecial(c, k, create))?.path || null : null; }
  return f;
}

// ---------- Klasörler ----------
app.get('/api/folders', auth, ah(async (req, res) => {
  res.json(await imap(req.s, async c => {
    const list = await c.list(), sp = classify(list);
    const out = [];
    for (const f of list) {
      if (!usable(f)) continue;
      let unseen = 0, total = 0;
      try { const st = await c.status(f.path, { unseen: true, messages: true }); unseen = st.unseen || 0; total = st.messages || 0; } catch {}
      const k = sp.get(f.path);
      out.push({ path: f.path, name: lastSeg(f), special: !k ? '' : k.startsWith('\\') ? k : KINDS[k].flag, unseen, total });
    }
    // Sunucuda olmayan standart klasörler: yer tutucu (ilk ihtiyaçta oluşturulur).
    for (const k of Object.keys(KINDS)) if (!out.some(f => f.special === KINDS[k].flag)) out.push({ path: VK + k, name: KINDS[k].create, special: KINDS[k].flag, unseen: 0, total: 0, virtual: true });
    return out;
  }));
}));

// Orijinal iletinin eklerini al (iletme / taslak): [{folder, uid, i}] -> nodemailer ekleri
async function fetchAtts(s, refs) {
  const list = (Array.isArray(refs) ? refs : []).slice(0, 20).filter(r => r && Number.isInteger(+r.uid) && +r.uid > 0 && Number.isInteger(+r.i) && +r.i >= 0);
  if (!list.length) return [];
  return imap(s, async c => {
    const out = [], cache = new Map();
    for (const r of list) {
      const folder = await resolveFolder(c, r.folder);
      if (!folder) continue;
      const key = folder + '\0' + r.uid;
      if (!cache.has(key)) {
        await c.mailboxOpen(folder, { readOnly: true });
        const m = await c.fetchOne(+r.uid, { source: true }, { uid: true });
        cache.set(key, m ? (await simpleParser(m.source)).attachments : []);
      }
      const a = cache.get(key)[+r.i];
      if (a) out.push({ filename: a.filename || 'ek', content: a.content, contentType: a.contentType });
    }
    return out;
  });
}
const parseRefs = v => { try { return JSON.parse(v || '[]'); } catch { return []; } };

// ---------- Liste ----------
app.get('/api/messages', auth, ah(async (req, res) => {
  const vf = req.query.folder || 'INBOX';
  const page = Math.max(1, +req.query.page || 1), per = 50, q = String(req.query.q || '').trim().slice(0, 200);
  res.json(await imap(req.s, async c => {
    const folder = await resolveFolder(c, vf);
    if (!folder) return { total: 0, page, per, messages: [] };      // henüz oluşturulmamış standart klasör
    const box = await c.mailboxOpen(folder, { readOnly: true });
    const q2 = { uid: true, envelope: true, flags: true, bodyStructure: true };
    let total, range, useUid = false;
    if (q || vf === VIRT_STARRED) {
      const crit = {};
      if (vf === VIRT_STARRED) crit.flagged = true;
      if (q) crit.or = [{ subject: q }, { from: q }, { body: q }];
      const uids = ((await c.search(crit, { uid: true })) || []).sort((a, b) => b - a);
      total = uids.length;
      const sl = uids.slice((page - 1) * per, page * per);
      range = sl.length ? sl.join(',') : null; useUid = true;
    } else {
      total = box.exists;
      const end = total - (page - 1) * per, start = Math.max(1, end - per + 1);
      range = end >= 1 ? `${start}:${end}` : null;
    }
    const raw = [];
    if (range) for await (const m of c.fetch(range, q2, useUid ? { uid: true } : {})) raw.push(m);
    // Önizleme: yalnız seçilen gövde parçasını (kısmi) çek, kodlamasını çöz. Parça numarasına göre gruplanır.
    const snip = new Map(), groups = new Map();
    for (const m of raw) {
      const info = pickPart(m.bodyStructure);
      if (!info) continue;
      m._info = info;
      const g = groups.get(info.part + '|' + info.max) || { part: info.part, max: info.max, uids: [] };
      g.uids.push(m.uid); groups.set(info.part + '|' + info.max, g);
    }
    for (const g of groups.values()) {
      try {
        for await (const m of c.fetch(g.uids.join(','), { uid: true, bodyParts: [{ key: g.part, start: 0, maxLength: g.max }] }, { uid: true })) {
          let buf = m.bodyParts?.get(g.part.toLowerCase()) || m.bodyParts?.get(g.part);
          if (!buf && m.bodyParts) for (const [k, v] of m.bodyParts) if (k.split('<')[0].toLowerCase() === g.part.toLowerCase()) buf = v;
          if (buf) snip.set(m.uid, buf);
        }
      } catch {}
    }
    const list = raw.map(m => {
      const fr = m.envelope?.from?.[0], to = m.envelope?.to?.[0];
      let snippet = '';
      try { snippet = snippetFromPart(snip.get(m.uid), m._info); } catch {}
      return { uid: m.uid, folder, subject: m.envelope?.subject || '(konu yok)',
        from: fr ? (fr.name || fr.address) : '', fromAddr: fr?.address || '', to: to ? (to.name || to.address) : '', date: m.envelope?.date,
        seen: m.flags.has('\\Seen'), flagged: m.flags.has('\\Flagged'), draft: m.flags.has('\\Draft'),
        hasAttachment: hasAtt(m.bodyStructure), snippet };
    });
    list.sort((a, b) => b.uid - a.uid);
    return { total, page, per, messages: list };
  }));
}));

// ---------- Tek ileti ----------
app.get('/api/message/:uid', auth, ah(async (req, res) => {
  const uid = +req.params.uid;
  if (!Number.isInteger(uid)) return res.sendStatus(400);
  res.json(await imap(req.s, async c => {
    const folder = await resolveFolder(c, req.query.folder);
    if (!folder) throw new Error('İleti bulunamadı');
    await c.mailboxOpen(folder);
    const m = await c.fetchOne(uid, { source: true, flags: true }, { uid: true });
    if (!m) throw new Error('İleti bulunamadı');
    if (!m.flags.has('\\Seen')) await c.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    const p = await simpleParser(m.source);
    const addr = x => (x?.value || []).map(v => v.address).filter(Boolean);
    return { subject: p.subject, from: p.from?.text, fromName: p.from?.value?.[0]?.name || '', fromAddr: p.from?.value?.[0]?.address || '',
      to: p.to?.text, cc: p.cc?.text || '', bcc: p.bcc?.text || '', toList: addr(p.to), ccList: addr(p.cc), date: p.date, html: p.html || null, text: p.text || '',
      replyTo: p.replyTo?.value?.[0]?.address || p.from?.value?.[0]?.address, messageId: p.messageId, inReplyTo: p.inReplyTo || '',
      references: [].concat(p.references || []).join(' '), flagged: m.flags.has('\\Flagged'), draft: m.flags.has('\\Draft'), folder,
      attachments: (p.attachments || []).map((a, i) => ({ i, name: a.filename, size: a.size })) };
  }));
}));

app.get('/api/message/:uid/att/:i', auth, ah(async (req, res) => {
  const a = await imap(req.s, async c => {
    const folder = await resolveFolder(c, req.query.folder);
    if (!folder) return null;
    await c.mailboxOpen(folder, { readOnly: true });
    const m = await c.fetchOne(+req.params.uid, { source: true }, { uid: true });
    return m ? (await simpleParser(m.source)).attachments[+req.params.i] : null;
  });
  if (!a) return res.sendStatus(404);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename || 'ek')}`);
  res.send(a.content);
}));

// ---------- Toplu işlemler ----------
function bulk(fn) {
  return [auth, ah(async (req, res) => {
    const uids = uidList(req.body?.uids);
    if (!uids.length) return res.status(400).json({ error: 'uids gerekli' });
    const out = await imap(req.s, async c => {
      const folder = await resolveFolder(c, req.body?.folder);
      if (!folder) return {};
      await c.mailboxOpen(folder);
      return fn(c, uids, folder, req.body);
    });
    res.json({ ok: true, ...(out || {}) });
  })];
}
app.post('/api/messages/flag', ...bulk(async (c, uids, f, b) => {
  if (b.flagged === false) await c.messageFlagsRemove(uids, ['\\Flagged'], { uid: true });
  else await c.messageFlagsAdd(uids, ['\\Flagged'], { uid: true });
}));
app.post('/api/messages/seen', ...bulk(async (c, uids, f, b) => {
  if (b.seen === false) await c.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
  else await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
}));
app.post('/api/messages/move', ...bulk(async (c, uids, folder, b) => {
  const to = await resolveFolder(c, String(b.to || ''), true);   // yer tutucuysa hedef klasör oluşturulur
  if (!b.to || b.to === VIRT_STARRED || !to) throw new Error('Hedef klasör gerekli');
  if (to !== folder) await c.messageMove(uids, to, { uid: true });
}));
app.post('/api/messages/archive', ...bulk(async (c, uids, folder) => {
  const a = await resolveSpecial(c, 'archive', true);
  if (a.path !== folder) await c.messageMove(uids, a.path, { uid: true });
}));
app.post('/api/messages/delete', ...bulk(async (c, uids, folder) => {
  const t = await resolveSpecial(c, 'trash', true);
  if (t.path === folder) await c.messageDelete(uids, { uid: true });
  else await c.messageMove(uids, t.path, { uid: true });
}));

// ---------- Gönderme / Taslak ----------
const MAXSZ = 20 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAXSZ, files: 10, fields: 20 } });
const mime = (e, req, res, next) => e ? res.status(e.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'Ek en fazla 20 MB olabilir' : 'Geçersiz istek' }) : next();
const up = (req, res, next) => upload.array('files', 10)(req, res, e => mime(e, req, res, next));

// İstek gövdesinden nodemailer iletisi kur (yeni yüklemeler + iletilen/taslaktan korunan ekler)
async function buildMail(req) {
  const b = req.body || {}, files = req.files || [];
  const kept = await fetchAtts(req.s, parseRefs(b.fwdAtts));
  const atts = [...kept, ...files.map(f => ({ filename: f.originalname, content: f.buffer, contentType: f.mimetype }))];
  const total = atts.reduce((n, a) => n + (a.content?.length || 0), 0);
  if (total > MAXSZ) { const e = new Error('Ekler toplamda en fazla 20 MB olabilir'); e.status = 413; throw e; }
  return { keptCount: kept.length, mail: { from: req.s.user, to: b.to || '', subject: b.subject || '', text: b.text || '',
    ...(b.cc ? { cc: b.cc } : {}), ...(b.bcc ? { bcc: b.bcc } : {}),
    ...(b.inReplyTo ? { inReplyTo: b.inReplyTo, references: b.references || b.inReplyTo } : {}),
    attachments: atts, keepBcc: true } };
}
const toRaw = mail => new Promise((ok, no) => nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(mail, (e, i) => e ? no(e) : ok(i.message)));
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

app.post('/api/send', auth, up, ah(async (req, res) => {
  const b = req.body || {};
  if (!b.to || !String(b.to).trim()) return res.status(400).json({ error: 'Alıcı gerekli' });
  let built; try { built = await buildMail(req); } catch (e) { return fail(res, e); }
  const { mail } = built;
  const t = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: true, auth: { user: req.s.user, pass: req.s.pass } });
  await t.sendMail({ ...mail, keepBcc: false });   // SMTP'ye giden kopyada Bcc başlığı yok (zarfta kalır)
  // Gönderilenler'e kopya + varsa taslağı sil
  let saved = true;
  await imap(req.s, async c => {
    const sent = await resolveSpecial(c, 'sent', true);
    await c.append(sent.path, await toRaw(mail), ['\\Seen']);
    const du = +b.draftUid;
    if (Number.isInteger(du) && du > 0) {
      const d = await resolveSpecial(c, 'drafts', false);
      if (d) { await c.mailboxOpen(d.path); await c.messageDelete([du], { uid: true }); }
    }
  }).catch(() => { saved = false; });
  res.json({ ok: true, sentCopy: saved });
}));

// Taslak kaydet: Taslaklar'a \Draft \Seen ile APPEND; önceki sürüm (draftUid) silinir.
app.post('/api/draft', auth, up, ah(async (req, res) => {
  const b = req.body || {};
  let built; try { built = await buildMail(req); } catch (e) { return fail(res, e); }
  const raw = await toRaw(built.mail);
  const out = await imap(req.s, async c => {
    const d = await resolveSpecial(c, 'drafts', true);
    const r = await c.append(d.path, raw, ['\\Draft', '\\Seen']);
    let uid = r?.uid || 0;
    if (!uid) {   // UIDPLUS yoksa Message-ID ile bul
      await c.mailboxOpen(d.path, { readOnly: true });
      const mid = (await simpleParser(raw)).messageId;
      const f = mid ? await c.search({ header: { 'message-id': mid } }, { uid: true }) : [];
      uid = f?.length ? Math.max(...f) : 0;
    }
    const old = +b.draftUid;
    if (Number.isInteger(old) && old > 0 && old !== uid) { await c.mailboxOpen(d.path); await c.messageDelete([old], { uid: true }).catch(() => {}); }
    return { uid, folder: d.path };
  });
  res.json({ ok: true, ...out, keptCount: built.keptCount });
}));

app.post('/api/draft/delete', auth, ah(async (req, res) => {
  const u = +req.body?.uid;
  if (!Number.isInteger(u) || u < 1) return res.status(400).json({ error: 'uid gerekli' });
  await imap(req.s, async c => {
    const d = await resolveSpecial(c, 'drafts', false);
    if (d) { await c.mailboxOpen(d.path); await c.messageDelete([u], { uid: true }); }
  });
  res.json({ ok: true });
}));

setInterval(() => { for (const [k, s] of sessions) if (Date.now() - s.t > TTL) sessions.delete(k); }, 600e3);
app.listen(process.env.PORT || 3000, () => console.log('mailbox on', process.env.PORT || 3000));
