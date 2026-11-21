// Gifted Gifter API — one Lambda behind an HTTP API (Cognito JWT authorizer)
// and a WebSocket API (live "something changed" pings).
//
// Table layout (pk / sk):
//   USER#<sub>  / PROFILE            {name, email}
//   USER#<sub>  / ITEM#<id>          wish-list item (+ boughtBy/boughtName/boughtAt, never shown to the owner)
//   USER#<sub>  / GROUP#<gid>        membership pointer
//   USER#<sub>  / BOUGHT#<owner>#<id> my shopping list entry
//   GROUP#<gid> / META               {name, code, ownerId, budget, date, notes, rules, drawnAt}
//   GROUP#<gid> / MEMBER#<sub>       {uid, name, joinedAt}
//   GROUP#<gid> / DRAW#<giver>       {receiver}  (each person only ever sees their own)
//   CODE#<code> / META               {gid}
import crypto from 'node:crypto';
import { store, Conflict } from './store.mjs';
import { drawNames } from './draw.mjs';
import { handleSocket, notify } from './live.mjs';
import { presign, deletePhoto } from './s3.mjs';
import { unfurl, fetchImage, isAmazonShort, resolveAmazonShort, cleanAmazon } from './unfurl.mjs';

const ORIGINS = (process.env.ALLOW_ORIGINS || '*').split(',');
const MAX_ITEMS = 200;
const MAX_MEMBERS = 60;

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };
const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(9).toString('base64url');
const newCode = () => Array.from(crypto.randomBytes(6), (b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');

// ---------- input cleaning ----------
const text = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const line = (s, max) => text(s, max).replace(/\s+/g, ' ');
function cleanUrl(u) {
  const s = text(u, 2000);
  if (!s) return '';
  try { const x = new URL(s); return ['http:', 'https:'].includes(x.protocol) ? x.href : ''; } catch { return ''; }
}
function cleanItem(b, uid) {
  const item = {
    title: line(b.title, 140),
    url: cleanUrl(b.url),
    price: line(b.price, 24),
    notes: text(b.notes, 600),
    priority: [0, 1, 2, 3, 4].includes(b.priority) ? b.priority : 0,
    qty: Number.isInteger(b.qty) && b.qty >= 1 && b.qty <= 20 ? b.qty : 1,
    imageKey: typeof b.imageKey === 'string' && b.imageKey.startsWith(`img/${uid}/`) && /^[\w/.-]{10,120}$/.test(b.imageKey) ? b.imageKey : '',
  };
  if (!item.title && item.url) item.title = titleFromUrl(item.url);
  if (!item.title && item.imageKey) item.title = 'Something like this';
  return item.title ? item : null;
}
// Whole wish lists from other sites get a friendly name.
function listTitle(x) {
  const h = x.hostname, p = x.pathname;
  if (/elfster\./i.test(h)) return 'My Elfster wish list';
  if (/amazon\.|amzn\./i.test(h) && /wishlist|registry|\/hz\//i.test(p)) return 'My Amazon wish list';
  if (/target\.com/i.test(h) && /registry|list/i.test(p)) return 'My Target list';
  if (/walmart\.com/i.test(h) && /lists|registry/i.test(p)) return 'My Walmart list';
  return '';
}
function titleFromUrl(u) {
  try {
    const x = new URL(u);
    const lt = listTitle(x);
    if (lt) return lt;
    const parts = x.pathname.split('/').filter((p) => p && !/^(dp|gp|product|p|ip|itm|item|products|s)$/i.test(p) && !/^[A-Z0-9]{10}$/.test(p) && !/^\d+$/.test(p));
    const best = parts.sort((a, b) => b.length - a.length)[0];
    if (best && best.length > 3) return decodeURIComponent(best).replace(/\.\w{2,5}$/, '').replace(/[-_+]+/g, ' ').trim().slice(0, 140);
    return x.hostname.replace(/^www\./, '');
  } catch { return ''; }
}
const cleanName = (s) => line(s, 40).replace(/[<>]/g, '');

// ---------- shared loaders ----------
async function profile(db, claims) {
  const uid = claims.sub;
  let p = await db.get('USER#' + uid, 'PROFILE');
  if (!p) {
    p = { pk: 'USER#' + uid, sk: 'PROFILE', uid, name: cleanName(claims.name || claims.nickname || String(claims.email || '').split('@')[0]) || 'Gifter', email: claims.email || '', createdAt: now() };
    await db.put(p);
  }
  return p;
}
async function groupFor(db, gid, uid) {
  const meta = await db.get('GROUP#' + gid, 'META');
  if (!meta) fail(404, 'Group not found');
  const me = await db.get('GROUP#' + gid, 'MEMBER#' + uid);
  if (!me) fail(403, 'You are not in this group');
  return meta;
}
const members = async (db, gid) => db.query('GROUP#' + gid, 'MEMBER#');
const myGroups = async (db, uid) => db.query('USER#' + uid, 'GROUP#');
// Everyone who can see uid's list (all members of all uid's groups).
async function audienceOf(db, uid) {
  const out = new Set();
  for (const g of await myGroups(db, uid)) for (const m of await members(db, g.gid)) out.add(m.uid);
  return [...out];
}

// Which groups can see an item: [] = all of the owner's groups, else just these group ids.
const visibleIn = (i, gid) => !(i.groups && i.groups.length) || i.groups.includes(gid);
async function cleanGroups(db, uid, groups) {
  if (!Array.isArray(groups) || !groups.length) return [];
  const mine = new Set((await myGroups(db, uid)).map((g) => g.gid));
  const out = [...new Set(groups.filter((g) => typeof g === 'string' && mine.has(g)))];
  if (!out.length) fail(400, "Pick at least one of your groups, or share with all of them");
  return out;
}

function itemOut(i, viewer) {
  const o = { id: i.id, title: i.title, url: i.url, price: i.price, notes: i.notes, priority: i.priority, qty: i.qty || 1, createdAt: i.createdAt, imageKey: i.imageKey || '' };
  if (viewer === i.owner) {
    o.groups = i.groups || [];
    o.canFetchPhoto = !!(i.url && !i.imageKey && !i.lookedUp); // the list page fills these in
  }
  if (i.imageKey) o.imageUrl = presign('GET', i.imageKey, 6 * 3600);
  // The owner never learns what was bought. Everyone else sees it so nobody double-buys.
  if (viewer !== i.owner && i.boughtBy) o.bought = { by: i.boughtName, mine: i.boughtBy === viewer, at: i.boughtAt };
  return o;
}
// 3 I NEED THIS! > 2 most wanted > 1 really want > 4 parent suggestion > 0 nice
const RANK = { 3: 4, 2: 3, 1: 2, 4: 1, 0: 0 };
const sortItems = (a, b) => (RANK[b.priority] - RANK[a.priority]) || (a.createdAt < b.createdAt ? -1 : 1);

// ---------- routes ----------
async function getMe(db, claims) {
  const p = await profile(db, claims);
  const gs = await myGroups(db, claims.sub);
  const groups = [];
  for (const g of gs) {
    const meta = await db.get('GROUP#' + g.gid, 'META');
    if (!meta) continue;
    const ms = await members(db, g.gid);
    groups.push({ id: meta.id, name: meta.name, kind: kindOf(meta), date: meta.date, budget: meta.budget, members: ms.length, drawn: !!meta.drawnAt, admin: meta.ownerId === claims.sub });
  }
  groups.sort((a, b) => (a.date || '9') < (b.date || '9') ? -1 : 1);
  const out = { id: p.uid, name: p.name, email: p.email, groups };
  if (p.kid) { out.kid = true; out.limited = p.limited !== false; out.parentName = (await db.get('USER#' + p.parentId, 'PROFILE'))?.name || ''; }
  return out;
}

async function putMe(db, claims, b) {
  const p = await profile(db, claims);
  const name = cleanName(b.name);
  if (!name) fail(400, 'Name needs some letters');
  p.name = name;
  await db.put(p);
  for (const g of await myGroups(db, claims.sub)) {
    const m = await db.get('GROUP#' + g.gid, 'MEMBER#' + claims.sub);
    if (m) { m.name = name; await db.put(m); }
  }
  await notify(await audienceOf(db, claims.sub), { type: 'changed', scope: 'group' });
  return { ok: true, name };
}

// Turn Amazon short links into full (taggable) product links.
async function expandLinks(items) {
  await Promise.all(items.map(async (it) => {
    if (it.url && isAmazonShort(it.url)) it.url = await resolveAmazonShort(it.url);
    else if (it.url) it.url = cleanAmazon(it.url);
  }));
}

async function myItems(db, uid) {
  const rows = await db.query('USER#' + uid, 'ITEM#');
  // Older items saved with short links get expanded the next time their owner opens the list.
  const short = rows.filter((r) => r.url && isAmazonShort(r.url)).slice(0, 15);
  await Promise.all(short.map(async (r) => {
    const full = await resolveAmazonShort(r.url);
    if (full === r.url) return;
    const next = { ...r, url: full, v: r.v + 1 };
    try { await db.put(next, { ifVersion: r.v }); Object.assign(r, next); } catch (e) { if (!(e instanceof Conflict)) throw e; }
  }));
  return rows.sort(sortItems).map((i) => itemOut(i, uid));
}

async function addItems(db, uid, b) {
  const raw = Array.isArray(b.items) ? b.items.slice(0, 100) : [b];
  const have = (await db.query('USER#' + uid, 'ITEM#')).length;
  const items = raw.map((r) => cleanItem(r || {}, uid)).filter(Boolean);
  if (!items.length) fail(400, 'Give it a name, a link or a photo');
  const groups = await cleanGroups(db, uid, b.groups);
  if (have + items.length > MAX_ITEMS) fail(400, `Lists hold up to ${MAX_ITEMS} things`);
  await expandLinks(items);
  const t = Date.now();
  const saved = [];
  for (const [k, it] of items.entries()) {
    const id = newId();
    const row = { pk: 'USER#' + uid, sk: 'ITEM#' + id, id, owner: uid, ...it, groups, createdAt: new Date(t + k).toISOString(), v: 1 };
    await db.put(row);
    saved.push(itemOut(row, uid));
  }
  await notify(await audienceOf(db, uid), { type: 'changed', scope: 'list', userId: uid });
  return { items: saved };
}

async function editItem(db, uid, id, b) {
  const row = await db.get('USER#' + uid, 'ITEM#' + id);
  if (!row) fail(404, 'Item not found');
  const it = cleanItem({ ...row, ...b, imageKey: b.imageKey !== undefined ? b.imageKey : row.imageKey }, uid);
  if (!it) fail(400, 'Give it a name, a link or a photo');
  if (row.imageKey && row.imageKey !== it.imageKey) await deletePhoto(row.imageKey);
  const groups = b.groups !== undefined ? await cleanGroups(db, uid, b.groups) : (row.groups || []);
  await expandLinks([it]);
  const next = { ...row, ...it, groups, v: row.v + 1, updatedAt: now() };
  if (next.url !== row.url) next.lookedUp = false; // new link: try for a photo again
  try { await db.put(next, { ifVersion: row.v }); } catch (e) { if (e instanceof Conflict) fail(409, 'Changed somewhere else — try again'); throw e; }
  if (row.boughtBy) {
    const s = await db.get('USER#' + row.boughtBy, `BOUGHT#${uid}#${id}`);
    if (s) { s.title = next.title; s.url = next.url; s.price = next.price; s.imageKey = next.imageKey; await db.put(s); }
  }
  await notify(await audienceOf(db, uid), { type: 'changed', scope: 'list', userId: uid });
  return itemOut(next, uid);
}

async function deleteItem(db, uid, id) {
  const row = await db.get('USER#' + uid, 'ITEM#' + id);
  if (!row) return { ok: true };
  await db.del('USER#' + uid, 'ITEM#' + id);
  if (row.boughtBy) {
    // The buyer already has it — keep it on their shopping list, flagged.
    const s = await db.get('USER#' + row.boughtBy, `BOUGHT#${uid}#${id}`);
    if (s) { s.removed = true; s.imageKey = ''; await db.put(s); }
    await notify([row.boughtBy], { type: 'changed', scope: 'shopping' });
  }
  await deletePhoto(row.imageKey);
  await notify(await audienceOf(db, uid), { type: 'changed', scope: 'list', userId: uid });
  return { ok: true };
}

function newUpload(uid, b) {
  const type = ['image/jpeg', 'image/png', 'image/webp'].includes(b.contentType) ? b.contentType : 'image/jpeg';
  const key = `img/${uid}/${newId()}.${type.split('/')[1].replace('jpeg', 'jpg')}`;
  return { key, uploadUrl: presign('PUT', key, 600, type), contentType: type };
}

// Paste a link → fill in the item's name, price and photo from the page.
async function lookupLink(uid, b) {
  const url = cleanUrl(b.url);
  if (!url) fail(400, "That doesn't look like a link");
  const within = (ms, work) => Promise.race([work, new Promise((r) => setTimeout(() => r(null), ms))]); // stay under the Lambda's 15 s
  const info = (await within(8000, unfurl(url))) || {};
  const out = { title: info.title || titleFromUrl(url), price: info.price || '', found: !!info.title };
  if (info.imageUrl && b.photo !== false && !process.env.MEMORY_STORE) {
    const img = await within(4500, fetchImage(info.imageUrl));
    if (img) {
      const key = `img/${uid}/${newId()}.${img.type.split('/')[1].replace('jpeg', 'jpg')}`;
      try {
        const put = await fetch(presign('PUT', key, 300, img.type), { method: 'PUT', headers: { 'content-type': img.type }, body: img.body });
        if (put.ok) { out.imageKey = key; out.imageUrl = presign('GET', key, 6 * 3600); }
      } catch (e) { console.error('photo save failed', e); }
    }
  }
  return out;
}

// Fill in a photo (and a missing price) for a linked item that has none — e.g. imported
// items. Tried once per link; owner or manager only.
async function itemPhoto(db, uid, id) {
  const row = await db.get('USER#' + uid, 'ITEM#' + id);
  if (!row) fail(404, 'Item not found');
  if (row.imageKey || !row.url || row.lookedUp) return itemOut(row, uid);
  const r = await lookupLink(uid, { url: row.url, photo: true });
  const fresh = await db.get('USER#' + uid, 'ITEM#' + id);
  if (!fresh || fresh.imageKey || fresh.url !== row.url) { if (r.imageKey) await deletePhoto(r.imageKey); return fresh ? itemOut(fresh, uid) : {}; }
  const next = { ...fresh, lookedUp: true, v: fresh.v + 1 };
  if (r.imageKey) next.imageKey = r.imageKey;
  if (r.found && r.price && !next.price) next.price = r.price;
  try { await db.put(next, { ifVersion: fresh.v }); }
  catch (e) { if (r.imageKey) await deletePhoto(r.imageKey); if (e instanceof Conflict) return itemOut(fresh, uid); throw e; }
  if (r.imageKey) await notify((await audienceOf(db, uid)).filter((x) => x !== uid), { type: 'changed', scope: 'list', userId: uid });
  return itemOut(next, uid);
}

async function shopping(db, uid) {
  const rows = await db.query('USER#' + uid, 'BOUGHT#');
  return rows.map((r) => ({
    ownerId: r.ownerId, ownerName: r.ownerName, itemId: r.itemId, gid: r.gid, title: r.title, url: r.url, price: r.price,
    boughtAt: r.boughtAt, removed: !!r.removed, imageUrl: r.imageKey ? presign('GET', r.imageKey, 6 * 3600) : '',
  })).sort((a, b) => (a.ownerName < b.ownerName ? -1 : 1));
}

async function createGroup(db, claims, b) {
  const p = await profile(db, claims);
  const name = line(b.name, 60);
  if (!name) fail(400, 'Name your group');
  const id = newId();
  let code;
  for (let i = 0; i < 5; i++) {
    code = newCode();
    try { await db.put({ pk: 'CODE#' + code, sk: 'META', gid: id }, { ifNew: true }); break; }
    catch (e) { if (!(e instanceof Conflict) || i === 4) throw e; }
  }
  const meta = { pk: 'GROUP#' + id, sk: 'META', id, name, code, kind: cleanKind(b.kind), ownerId: p.uid, budget: line(b.budget, 30), date: cleanDate(b.date), notes: text(b.notes, 600), rules: { households: {}, exclusions: [], noPairs: false }, drawnAt: null, createdAt: now(), v: 1 };
  await db.put(meta);
  await join(db, p, meta);
  return { id };
}
const cleanDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : '');
// 'exchange' = draw names; 'lists' = just share wish lists (family, friends), no draw.
const cleanKind = (k) => (k === 'lists' ? 'lists' : 'exchange');
const kindOf = (meta) => meta.kind || 'exchange';

async function join(db, p, meta) {
  await db.put({ pk: 'GROUP#' + meta.id, sk: 'MEMBER#' + p.uid, uid: p.uid, name: p.name, joinedAt: now() });
  await db.put({ pk: 'USER#' + p.uid, sk: 'GROUP#' + meta.id, gid: meta.id });
}

async function joinByCode(db, claims, b) {
  const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = code && await db.get('CODE#' + code, 'META');
  if (!c) fail(404, 'No group has that code');
  const meta = await db.get('GROUP#' + c.gid, 'META');
  if (!meta) fail(404, 'That group was deleted');
  const p = await profile(db, claims);
  if (!(await db.get('GROUP#' + meta.id, 'MEMBER#' + p.uid))) {
    if ((await members(db, meta.id)).length >= MAX_MEMBERS) fail(400, 'That group is full');
    await join(db, p, meta);
    await notify((await members(db, meta.id)).map((m) => m.uid), { type: 'changed', scope: 'group', groupId: meta.id });
  }
  return { id: meta.id };
}

async function getGroup(db, uid, gid) {
  const meta = await groupFor(db, gid, uid);
  const ms = await members(db, gid);
  const admin = meta.ownerId === uid;
  const counts = {};
  await Promise.all(ms.map(async (m) => { counts[m.uid] = (await db.query('USER#' + m.uid, 'ITEM#')).filter((i) => visibleIn(i, gid)).length; }));
  const draw = meta.drawnAt ? await db.get('GROUP#' + gid, 'DRAW#' + uid) : null;
  const drawnIds = meta.drawnAt ? new Set((await db.query('GROUP#' + gid, 'DRAW#')).map((d) => d.giver)) : null;
  const byId = Object.fromEntries(ms.map((m) => [m.uid, m]));
  return {
    id: meta.id, name: meta.name, kind: kindOf(meta), code: meta.code, budget: meta.budget, date: meta.date, notes: meta.notes,
    admin, ownerId: meta.ownerId, drawnAt: meta.drawnAt,
    members: ms.map((m) => ({ id: m.uid, name: m.name, items: counts[m.uid] || 0, inDraw: drawnIds ? drawnIds.has(m.uid) : null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    you: uid,
    giftingTo: draw && byId[draw.receiver] ? { id: draw.receiver, name: byId[draw.receiver].name } : null,
    rules: admin ? meta.rules : undefined,
  };
}

async function putGroup(db, uid, gid, b) {
  const meta = await groupFor(db, gid, uid);
  if (meta.ownerId !== uid) fail(403, 'Only the organizer can change this');
  if (b.name !== undefined) meta.name = line(b.name, 60) || meta.name;
  if (b.budget !== undefined) meta.budget = line(b.budget, 30);
  if (b.date !== undefined) meta.date = cleanDate(b.date);
  if (b.notes !== undefined) meta.notes = text(b.notes, 600);
  if (b.kind !== undefined && cleanKind(b.kind) !== kindOf(meta)) {
    meta.kind = cleanKind(b.kind);
    if (meta.kind === 'lists' && meta.drawnAt) { // a list-sharing group has no draw
      for (const d of await db.query('GROUP#' + gid, 'DRAW#')) await db.del(d.pk, d.sk);
      meta.drawnAt = null;
    }
  }
  if (b.rules !== undefined) {
    const ids = new Set((await members(db, gid)).map((m) => m.uid));
    const hh = {};
    for (const [k, v] of Object.entries(b.rules.households || {})) if (ids.has(k) && line(v, 30)) hh[k] = line(v, 30);
    const ex = (Array.isArray(b.rules.exclusions) ? b.rules.exclusions : [])
      .filter((p) => Array.isArray(p) && p.length === 2 && ids.has(p[0]) && ids.has(p[1]) && p[0] !== p[1]).slice(0, 200);
    meta.rules = { households: hh, exclusions: ex, noPairs: !!b.rules.noPairs };
  }
  const prev = meta.v;
  meta.v = prev + 1;
  try { await db.put(meta, { ifVersion: prev }); } catch (e) { if (e instanceof Conflict) fail(409, 'Changed somewhere else — try again'); throw e; }
  await notify((await members(db, gid)).map((m) => m.uid), { type: 'changed', scope: 'group', groupId: gid });
  return { ok: true };
}

// Organizer swaps the invite code: the old link and code stop working; members stay.
async function newInviteCode(db, uid, gid) {
  const meta = await groupFor(db, gid, uid);
  if (meta.ownerId !== uid) fail(403, 'Only the organizer can change the invite code');
  let code;
  for (let i = 0; i < 5; i++) {
    code = newCode();
    try { await db.put({ pk: 'CODE#' + code, sk: 'META', gid }, { ifNew: true }); break; }
    catch (e) { if (!(e instanceof Conflict) || i === 4) throw e; }
  }
  const old = meta.code;
  const prev = meta.v;
  meta.code = code;
  meta.v = prev + 1;
  try { await db.put(meta, { ifVersion: prev }); }
  catch (e) { await db.del('CODE#' + code, 'META'); if (e instanceof Conflict) fail(409, 'Changed somewhere else — try again'); throw e; }
  await db.del('CODE#' + old, 'META');
  return { code };
}

async function deleteGroup(db, uid, gid) {
  const meta = await groupFor(db, gid, uid);
  if (meta.ownerId !== uid) fail(403, 'Only the organizer can delete the group');
  const ms = await members(db, gid);
  for (const r of await db.query('GROUP#' + gid)) await db.del(r.pk, r.sk);
  for (const m of ms) await db.del('USER#' + m.uid, 'GROUP#' + gid);
  await db.del('CODE#' + meta.code, 'META');
  await notify(ms.map((m) => m.uid), { type: 'changed', scope: 'group', groupId: gid });
  return { ok: true };
}

async function removeMember(db, uid, gid, who) {
  const meta = await groupFor(db, gid, uid);
  if (who !== uid && meta.ownerId !== uid) fail(403, 'Only the organizer can remove people');
  if (who === meta.ownerId) fail(400, 'The organizer can delete the group instead');
  const before = await members(db, gid);
  await db.del('GROUP#' + gid, 'MEMBER#' + who);
  await db.del('USER#' + who, 'GROUP#' + gid);
  await notify(before.map((m) => m.uid), { type: 'changed', scope: 'group', groupId: gid });
  return { ok: true };
}

async function memberList(db, uid, gid, who) {
  await groupFor(db, gid, uid);
  const m = await db.get('GROUP#' + gid, 'MEMBER#' + who);
  if (!m) fail(404, 'Not in this group');
  const items = (await db.query('USER#' + who, 'ITEM#')).filter((i) => visibleIn(i, gid)).sort(sortItems).map((i) => itemOut(i, uid));
  return { id: who, name: m.name, items, yours: who === uid };
}

async function setBought(db, claims, gid, owner, id, on) {
  const uid = claims.sub;
  await groupFor(db, gid, uid);
  if (owner === uid) fail(400, "That's your own list — no peeking!");
  if (!(await db.get('GROUP#' + gid, 'MEMBER#' + owner))) fail(404, 'Not in this group');
  const row = await db.get('USER#' + owner, 'ITEM#' + id);
  if (!row || !visibleIn(row, gid)) fail(404, 'That item was removed');
  const p = await profile(db, claims);
  if (on) {
    if (row.boughtBy && row.boughtBy !== uid) fail(409, `${row.boughtName} already bought this`);
    if (row.boughtBy === uid) return { ok: true };
    Object.assign(row, { boughtBy: uid, boughtName: p.name, boughtAt: now() });
  } else {
    if (!row.boughtBy) return { ok: true };
    if (row.boughtBy !== uid) fail(403, 'Only the person who bought it can undo that');
    delete row.boughtBy; delete row.boughtName; delete row.boughtAt;
  }
  const prev = row.v;
  row.v = prev + 1;
  try { await db.put(row, { ifVersion: prev }); } catch (e) { if (e instanceof Conflict) fail(409, 'Someone just changed this — refresh and try again'); throw e; }
  const ownerM = await db.get('GROUP#' + gid, 'MEMBER#' + owner);
  if (on) {
    await db.put({ pk: 'USER#' + uid, sk: `BOUGHT#${owner}#${id}`, ownerId: owner, ownerName: ownerM.name, itemId: id, gid, title: row.title, url: row.url, price: row.price, imageKey: row.imageKey || '', boughtAt: row.boughtAt });
  } else {
    await db.del('USER#' + uid, `BOUGHT#${owner}#${id}`);
  }
  // Everyone who can see the list hears about it — except the person it's for.
  await notify((await audienceOf(db, owner)).filter((x) => x !== owner), { type: 'changed', scope: 'list', userId: owner });
  return { ok: true };
}

async function runDraw(db, uid, gid) {
  const meta = await groupFor(db, gid, uid);
  if (meta.ownerId !== uid) fail(403, 'Only the organizer can draw names');
  if (kindOf(meta) === 'lists') fail(400, 'This group just shares lists — switch it to a gift exchange to draw names');
  const ms = await members(db, gid);
  if (ms.length < 3) fail(400, 'You need at least 3 people to draw names');
  const result = drawNames(ms.map((m) => m.uid), meta.rules || {});
  if (!result) fail(409, 'No draw fits those rules — loosen a household or exclusion and try again');
  for (const d of await db.query('GROUP#' + gid, 'DRAW#')) await db.del(d.pk, d.sk);
  for (const [giver, receiver] of Object.entries(result)) await db.put({ pk: 'GROUP#' + gid, sk: 'DRAW#' + giver, giver, receiver });
  meta.drawnAt = now();
  meta.v += 1;
  await db.put(meta);
  await notify(ms.map((m) => m.uid), { type: 'changed', scope: 'group', groupId: gid, drawn: true });
  return { ok: true, drawnAt: meta.drawnAt };
}

async function resetDraw(db, uid, gid) {
  const meta = await groupFor(db, gid, uid);
  if (meta.ownerId !== uid) fail(403, 'Only the organizer can reset the draw');
  for (const d of await db.query('GROUP#' + gid, 'DRAW#')) await db.del(d.pk, d.sk);
  meta.drawnAt = null;
  meta.v += 1;
  await db.put(meta);
  await notify((await members(db, gid)).map((m) => m.uid), { type: 'changed', scope: 'group', groupId: gid });
  return { ok: true };
}

// ---------- private lists (only the owner ever sees these) ----------
//   USER#<sub> / PLIST#<lid>          {name, createdAt}
//   USER#<sub> / PITEM#<lid>#<iid>    {title, url, price, notes, done}
const MAX_PLISTS = 50, MAX_PITEMS = 300;
const plistOut = (l, items) => ({ id: l.id, name: l.name, createdAt: l.createdAt, count: items.length, open: items.filter((i) => !i.done).length });
const pitemOut = (i) => ({ id: i.id, title: i.title, url: i.url, price: i.price, notes: i.notes, done: !!i.done, createdAt: i.createdAt });
function cleanPItem(b) {
  const it = { title: line(b.title, 140), url: cleanUrl(b.url), price: line(b.price, 24), notes: text(b.notes, 600) };
  if (!it.title && it.url) it.title = titleFromUrl(it.url);
  return it.title ? it : null;
}
async function plist(db, uid, lid) {
  const l = await db.get('USER#' + uid, 'PLIST#' + lid);
  if (!l) fail(404, 'List not found');
  return l;
}
const pitems = (db, uid, lid) => db.query('USER#' + uid, `PITEM#${lid}#`);
const sortP = (a, b) => (a.done - b.done) || (a.createdAt < b.createdAt ? -1 : 1);
const pchanged = (uid, lid) => notify([uid], { type: 'changed', scope: 'plists', listId: lid });

async function privateRoute(db, uid, method, parts, b) {
  const [, lid, y, iid] = parts;
  const is = (m, n) => method === m && parts.length === n;
  if (is('GET', 1)) {
    const lists = await db.query('USER#' + uid, 'PLIST#');
    const all = await db.query('USER#' + uid, 'PITEM#');
    return { lists: lists.map((l) => plistOut(l, all.filter((i) => i.listId === l.id))).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)) };
  }
  if (is('POST', 1)) {
    const name = line(b.name, 60);
    if (!name) fail(400, 'Name your list');
    if ((await db.query('USER#' + uid, 'PLIST#')).length >= MAX_PLISTS) fail(400, `Up to ${MAX_PLISTS} private lists`);
    const id = newId();
    const l = { pk: 'USER#' + uid, sk: 'PLIST#' + id, id, name, createdAt: now() };
    await db.put(l);
    await pchanged(uid, id);
    return plistOut(l, []);
  }
  const l = await plist(db, uid, lid);
  if (is('GET', 2)) return { list: plistOut(l, []), items: (await pitems(db, uid, lid)).sort(sortP).map(pitemOut) };
  if (is('PUT', 2)) {
    const name = line(b.name, 60);
    if (!name) fail(400, 'Name your list');
    l.name = name; await db.put(l); await pchanged(uid, lid);
    return { ok: true };
  }
  if (is('DELETE', 2)) {
    for (const i of await pitems(db, uid, lid)) await db.del(i.pk, i.sk);
    await db.del(l.pk, l.sk); await pchanged(uid, lid);
    return { ok: true };
  }
  if (y === 'clear-done' && is('POST', 3)) {
    for (const i of await pitems(db, uid, lid)) if (i.done) await db.del(i.pk, i.sk);
    await pchanged(uid, lid);
    return { ok: true };
  }
  if (y === 'items' && is('POST', 3)) {
    const raw = Array.isArray(b.items) ? b.items.slice(0, 100) : [b];
    const add = raw.map((r) => cleanPItem(r || {})).filter(Boolean);
    if (!add.length) fail(400, 'Type something to add');
    if ((await pitems(db, uid, lid)).length + add.length > MAX_PITEMS) fail(400, `Lists hold up to ${MAX_PITEMS} things`);
    await expandLinks(add);
    const t = Date.now(), out = [];
    for (const [k, it] of add.entries()) {
      const id = newId();
      const row = { pk: 'USER#' + uid, sk: `PITEM#${lid}#${id}`, id, listId: lid, ...it, done: false, createdAt: new Date(t + k).toISOString() };
      await db.put(row); out.push(pitemOut(row));
    }
    await pchanged(uid, lid);
    return { items: out };
  }
  if (y === 'items' && parts.length === 4) {
    const row = await db.get('USER#' + uid, `PITEM#${lid}#${iid}`);
    if (!row) fail(404, 'Item not found');
    if (method === 'DELETE') { await db.del(row.pk, row.sk); await pchanged(uid, lid); return { ok: true }; }
    if (method === 'PUT') {
      if (b.title !== undefined || b.url !== undefined || b.price !== undefined || b.notes !== undefined) {
        const it = cleanPItem({ ...row, ...b });
        if (!it) fail(400, 'Give it a name');
        await expandLinks([it]);
        Object.assign(row, it);
      }
      if (b.done !== undefined) row.done = !!b.done;
      await db.put(row); await pchanged(uid, lid);
      return pitemOut(row);
    }
  }
  fail(404, 'Not found');
}

// ---------- managed accounts (internally "kids") ----------
// Someone with a normal Cognito account creates accounts for people without an email
// (kids, grandparents…). They sign in with a one-time code/link and get a long-lived
// device token, stored hashed. A managed account is either:
//   limited (profile.limited, the default for older kid accounts): own list + the groups
//            the manager picks, nothing else
//   full     (limited === false): can also rename themselves, join/leave/start groups
// Records:
//   USER#<parent> / KID#<kidId>      the parent's link to the kid
//   USER#<kidId>  / PROFILE          {name, kid: true, parentId}
//   USER#<kidId>  / TOKEN#<hash>     one per signed-in device
//   KIDTOKEN#<hash> / META           {kidId}  token lookup
//   KIDCODE#<code>  / META           {kidId}  standing sign-in code, no time limit (profile.loginCode)
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function kidOf(db, parentUid, kidId) {
  const link = await db.get('USER#' + parentUid, 'KID#' + kidId);
  if (!link) fail(404, 'Account not found');
  const p = await db.get('USER#' + kidId, 'PROFILE');
  if (!p) fail(404, 'Account not found');
  return p;
}

async function listKids(db, parentUid) {
  const links = await db.query('USER#' + parentUid, 'KID#');
  const out = [];
  for (const l of links) {
    const p = await db.get('USER#' + l.kidId, 'PROFILE');
    if (!p) continue;
    const gs = await myGroups(db, l.kidId);
    const groups = [];
    for (const g of gs) { const meta = await db.get('GROUP#' + g.gid, 'META'); if (meta) groups.push({ id: meta.id, name: meta.name }); }
    const devices = (await db.query('USER#' + l.kidId, 'TOKEN#')).length;
    const items = (await db.query('USER#' + l.kidId, 'ITEM#')).length;
    out.push({ id: l.kidId, name: p.name, limited: p.limited !== false, groups, devices, items });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function setKidGroups(db, parentUid, kid, wanted) {
  const mine = new Set((await myGroups(db, parentUid)).map((g) => g.gid));
  const target = new Set((Array.isArray(wanted) ? wanted : []).filter((g) => mine.has(g)));
  const current = new Set((await myGroups(db, kid.uid)).map((g) => g.gid));
  for (const gid of current) {
    if (target.has(gid) || !mine.has(gid)) continue; // groups they joined themselves aren't the manager's to change
    const meta = await db.get('GROUP#' + gid, 'META');
    if (meta && meta.ownerId === kid.uid) fail(400, `${kid.name} organizes ${meta.name}, so they can't be taken out of it`);
    await db.del('GROUP#' + gid, 'MEMBER#' + kid.uid);
    await db.del('USER#' + kid.uid, 'GROUP#' + gid);
    await notify((await members(db, gid)).map((m) => m.uid), { type: 'changed', scope: 'group', groupId: gid });
  }
  for (const gid of target) {
    if (current.has(gid)) continue;
    const meta = await db.get('GROUP#' + gid, 'META');
    if (!meta) continue;
    if ((await members(db, gid)).length >= MAX_MEMBERS) fail(400, `${meta.name} is full`);
    await join(db, kid, meta);
    await notify((await members(db, gid)).map((m) => m.uid), { type: 'changed', scope: 'group', groupId: gid });
  }
}

async function createKid(db, claims, b) {
  const parent = await profile(db, claims);
  if (parent.kid) fail(403, "Managed accounts can't set up other accounts");
  const name = cleanName(b.name);
  if (!name) fail(400, "What's their name?");
  if ((await db.query('USER#' + parent.uid, 'KID#')).length >= 12) fail(400, 'Up to 12 managed accounts each');
  const kidId = 'kid_' + newId();
  const kid = { pk: 'USER#' + kidId, sk: 'PROFILE', uid: kidId, name, kid: true, limited: !!b.limited, parentId: parent.uid, email: '', createdAt: now() };
  await db.put(kid);
  await db.put({ pk: 'USER#' + parent.uid, sk: 'KID#' + kidId, kidId });
  await setKidGroups(db, parent.uid, kid, b.groups);
  return { id: kidId };
}

async function updateKid(db, parentUid, kidId, b) {
  const kid = await kidOf(db, parentUid, kidId);
  if (b.name !== undefined) {
    const name = cleanName(b.name);
    if (!name) fail(400, 'Name needs some letters');
    kid.name = name;
    await db.put(kid);
    for (const g of await myGroups(db, kidId)) {
      const m = await db.get('GROUP#' + g.gid, 'MEMBER#' + kidId);
      if (m) { m.name = name; await db.put(m); }
    }
  }
  if (b.limited !== undefined && !!b.limited !== (kid.limited !== false)) { kid.limited = !!b.limited; await db.put(kid); }
  if (b.groups !== undefined) await setKidGroups(db, parentUid, kid, b.groups);
  return { ok: true };
}

async function signOutKid(db, kidId) {
  const kid = await db.get('USER#' + kidId, 'PROFILE');
  if (kid) await revokeLoginCode(db, kid); // their link stops working too
  for (const t of await db.query('USER#' + kidId, 'TOKEN#')) {
    await db.del('KIDTOKEN#' + t.hash, 'META');
    await db.del(t.pk, t.sk);
  }
}

async function deleteKid(db, parentUid, kidId) {
  const kid = await kidOf(db, parentUid, kidId);
  // Groups they organize pass to the longest-standing other member (or are deleted if empty).
  for (const g of await myGroups(db, kidId)) {
    const meta = await db.get('GROUP#' + g.gid, 'META');
    if (!meta || meta.ownerId !== kidId) continue;
    const others = (await members(db, g.gid)).filter((m) => m.uid !== kidId).sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : 1));
    if (others.length) { meta.ownerId = others[0].uid; meta.v += 1; await db.put(meta); }
    else await deleteGroup(db, kidId, g.gid);
  }
  await setKidGroups(db, parentUid, kid, []);
  for (const g of await myGroups(db, kidId)) { // groups the parent has since left
    await db.del('GROUP#' + g.gid, 'MEMBER#' + kidId);
    await db.del('USER#' + kidId, 'GROUP#' + g.gid);
  }
  for (const i of await db.query('USER#' + kidId, 'ITEM#')) { await deletePhoto(i.imageKey); await db.del(i.pk, i.sk); }
  await signOutKid(db, kidId);
  for (const r of await db.query('USER#' + kidId)) await db.del(r.pk, r.sk);
  await db.del('USER#' + parentUid, 'KID#' + kidId);
  return { ok: true };
}

// Each managed account has one standing sign-in link: it works on any number of devices
// until the manager makes a new one, signs them out everywhere, or removes the account.
async function revokeLoginCode(db, kid) {
  if (!kid.loginCode) return;
  await db.del('KIDCODE#' + kid.loginCode, 'META');
  delete kid.loginCode;
  await db.put(kid);
}

async function kidLoginCode(db, parentUid, kidId, b) {
  const kid = await kidOf(db, parentUid, kidId);
  if (kid.loginCode && !b.fresh && await db.get('KIDCODE#' + kid.loginCode, 'META')) return { code: kid.loginCode };
  await revokeLoginCode(db, kid);
  for (let i = 0; i < 5; i++) {
    const code = newCode() + newCode().slice(0, 2); // 8 characters
    try {
      await db.put({ pk: 'KIDCODE#' + code, sk: 'META', kidId, createdAt: now() }, { ifNew: true });
      kid.loginCode = code;
      await db.put(kid);
      return { code };
    } catch (e) { if (!(e instanceof Conflict)) throw e; }
  }
  fail(500, 'Try again');
}

async function kidLogin(db, b) {
  const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = code.length === 8 && await db.get('KIDCODE#' + code, 'META');
  if (!c || (c.exp && c.exp < Date.now())) fail(404, "That code didn't work. Ask whoever set up your account for a new one.");
  if (c.exp) await db.del('KIDCODE#' + code, 'META'); // older 15-minute codes stay one-use
  const kid = await db.get('USER#' + c.kidId, 'PROFILE');
  if (!kid) fail(404, 'That account was removed');
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = hashToken(token);
  await db.put({ pk: 'KIDTOKEN#' + hash, sk: 'META', kidId: kid.uid, createdAt: now() });
  await db.put({ pk: 'USER#' + kid.uid, sk: 'TOKEN#' + hash, hash, createdAt: now() });
  return { token, id: kid.uid, name: kid.name };
}

export async function kidClaims(db, token) {
  if (!token) return null;
  const t = await db.get('KIDTOKEN#' + hashToken(token), 'META');
  if (!t) return null;
  const p = await db.get('USER#' + t.kidId, 'PROFILE');
  return p ? { sub: p.uid, name: p.name, kid: true, limited: p.limited !== false, parentId: p.parentId } : null;
}

async function kidsRoute(db, claims, method, parts, b) {
  const uid = claims.sub;
  const [, kidId, y, z] = parts;
  const is = (m, n) => method === m && parts.length === n;
  if (is('GET', 1)) return { kids: await listKids(db, uid) };
  if (is('POST', 1)) return createKid(db, claims, b);
  await kidOf(db, uid, kidId);
  if (is('PUT', 2)) return updateKid(db, uid, kidId, b);
  if (is('DELETE', 2)) return deleteKid(db, uid, kidId);
  if (y === 'login-code' && is('POST', 3)) return kidLoginCode(db, uid, kidId, b);
  if (y === 'devices' && is('DELETE', 3)) { await signOutKid(db, kidId); return { ok: true }; }
  // The parent edits the kid's list. Bought marks stay hidden: the list is shown as the kid sees it.
  if (y === 'items') {
    if (is('GET', 3)) return { items: await myItems(db, kidId) };
    if (is('POST', 3)) return addItems(db, kidId, b);
    if (is('PUT', 4)) return editItem(db, kidId, z, b);
    if (parts[4] === 'photo' && is('POST', 5)) return itemPhoto(db, kidId, z);
    if (is('DELETE', 4)) return deleteItem(db, kidId, z);
  }
  if (y === 'uploads' && is('POST', 3)) return newUpload(kidId, b);
  if (y === 'unfurl' && is('POST', 3)) return lookupLink(kidId, b);
  fail(404, 'Not found');
}

// What a kid's own device may do: their list, lists in their groups, marking things bought.
function kidAllowed(method, parts) {
  const [a, , y] = parts;
  if (a === 'me' || a === 'items' || a === 'uploads' || a === 'unfurl' || a === 'shopping' || a === 'private') return !(a === 'me' && method !== 'GET');
  if (a === 'groups') return (method === 'GET' && parts.length === 2) || y === 'lists';
  return false;
}

// ---------- HTTP plumbing ----------
function cors(event) {
  const o = event.headers?.origin || '';
  return ORIGINS.includes('*') ? '*' : ORIGINS.includes(o) ? o : ORIGINS[0];
}
function reply(event, code, body) {
  return { statusCode: code, headers: { 'content-type': 'application/json', 'access-control-allow-origin': cors(event) }, body: JSON.stringify(body) };
}
function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > 200000) fail(413, 'Too much at once');
  try { const b = JSON.parse(raw); if (b && typeof b === 'object') return b; } catch {}
  fail(400, 'Body must be JSON');
}

async function route(db, claims, method, parts, b) {
  const uid = claims.sub;
  const [a, x, y, z, w, v] = parts;
  const is = (m, n) => method === m && parts.length === n;
  if (claims.kid && a === 'kids') fail(403, "Managed accounts can't set up other accounts");
  if (claims.kid && claims.limited && !kidAllowed(method, parts)) fail(403, 'Ask whoever manages your account to do that');
  if (a === 'kids') return kidsRoute(db, claims, method, parts, b);
  if (a === 'me' && is('GET', 1)) return getMe(db, claims);
  if (a === 'me' && is('PUT', 1)) return putMe(db, claims, b);
  if (a === 'items') {
    await profile(db, claims);
    if (is('GET', 1)) return { items: await myItems(db, uid) };
    if (is('POST', 1)) return addItems(db, uid, b);
    if (is('PUT', 2)) return editItem(db, uid, x, b);
    if (y === 'photo' && is('POST', 3)) return itemPhoto(db, uid, x);
    if (is('DELETE', 2)) return deleteItem(db, uid, x);
  }
  if (a === 'uploads' && is('POST', 1)) return newUpload(uid, b);
  if (a === 'unfurl' && is('POST', 1)) return lookupLink(uid, b);
  if (a === 'shopping' && is('GET', 1)) return { items: await shopping(db, uid) };
  if (a === 'private') return privateRoute(db, uid, method, parts, b);
  if (a === 'join' && is('POST', 1)) return joinByCode(db, claims, b);
  if (a === 'groups') {
    if (is('POST', 1)) return createGroup(db, claims, b);
    if (is('GET', 2)) return getGroup(db, uid, x);
    if (is('PUT', 2)) return putGroup(db, uid, x, b);
    if (is('DELETE', 2)) return deleteGroup(db, uid, x);
    if (y === 'members' && is('DELETE', 4)) return removeMember(db, uid, x, z);
    if (y === 'code' && is('POST', 3)) return newInviteCode(db, uid, x);
    if (y === 'draw' && is('POST', 3)) return runDraw(db, uid, x);
    if (y === 'draw' && is('DELETE', 3)) return resetDraw(db, uid, x);
    if (y === 'lists' && is('GET', 4)) return memberList(db, uid, x, z);
    if (y === 'lists' && w === 'items' && parts[6] === 'bought' && parts.length === 7) {
      if (method === 'POST') return setBought(db, claims, x, z, v, true);
      if (method === 'DELETE') return setBought(db, claims, x, z, v, false);
    }
  }
  fail(404, 'Not found');
}

export const handler = async (event) => {
  if (event.requestContext?.eventType) return handleSocket(event);
  try {
    const method = event.requestContext.http.method;
    let parts = (event.rawPath || '/').split('/').filter(Boolean).map(decodeURIComponent);
    const b = ['POST', 'PUT'].includes(method) ? parseBody(event) : {};
    const db = await store();
    // /public/* and /kid/* skip the Cognito authorizer (see template.yaml) and are checked here.
    if (parts[0] === 'public') {
      if (parts[1] === 'kid-login' && method === 'POST' && parts.length === 2) return reply(event, 200, await kidLogin(db, b));
      fail(404, 'Not found');
    }
    let claims;
    if (parts[0] === 'kid') {
      const auth = event.headers?.authorization || event.headers?.Authorization || '';
      claims = await kidClaims(db, auth.replace(/^Kid\s+/i, ''));
      if (!claims) fail(401, 'Signed out — ask whoever set up your account for a new sign-in code');
      parts = parts.slice(1);
    } else {
      claims = event.requestContext?.authorizer?.jwt?.claims;
      if (!claims?.sub) fail(401, 'Sign in first');
      if (String(claims.sub).startsWith('kid_')) fail(401, 'Sign in first');
    }
    return reply(event, 200, await route(db, claims, method, parts, b));
  } catch (e) {
    if (e instanceof HttpError) return reply(event, e.code, { error: e.message });
    console.error(e);
    return reply(event, 500, { error: 'Something went wrong on our side' });
  }
};
