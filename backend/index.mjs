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
    priority: [0, 1, 2].includes(b.priority) ? b.priority : 0,
    qty: Number.isInteger(b.qty) && b.qty >= 1 && b.qty <= 20 ? b.qty : 1,
    imageKey: typeof b.imageKey === 'string' && b.imageKey.startsWith(`img/${uid}/`) && /^[\w/.-]{10,120}$/.test(b.imageKey) ? b.imageKey : '',
  };
  if (!item.title && item.url) item.title = titleFromUrl(item.url);
  if (!item.title && item.imageKey) item.title = 'Something like this';
  return item.title ? item : null;
}
function titleFromUrl(u) {
  try {
    const x = new URL(u);
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

function itemOut(i, viewer) {
  const o = { id: i.id, title: i.title, url: i.url, price: i.price, notes: i.notes, priority: i.priority, qty: i.qty || 1, createdAt: i.createdAt, imageKey: i.imageKey || '' };
  if (i.imageKey) o.imageUrl = presign('GET', i.imageKey, 6 * 3600);
  // The owner never learns what was bought. Everyone else sees it so nobody double-buys.
  if (viewer !== i.owner && i.boughtBy) o.bought = { by: i.boughtName, mine: i.boughtBy === viewer, at: i.boughtAt };
  return o;
}
const sortItems = (a, b) => (b.priority - a.priority) || (a.createdAt < b.createdAt ? -1 : 1);

// ---------- routes ----------
async function getMe(db, claims) {
  const p = await profile(db, claims);
  const gs = await myGroups(db, claims.sub);
  const groups = [];
  for (const g of gs) {
    const meta = await db.get('GROUP#' + g.gid, 'META');
    if (!meta) continue;
    const ms = await members(db, g.gid);
    groups.push({ id: meta.id, name: meta.name, date: meta.date, budget: meta.budget, members: ms.length, drawn: !!meta.drawnAt, admin: meta.ownerId === claims.sub });
  }
  groups.sort((a, b) => (a.date || '9') < (b.date || '9') ? -1 : 1);
  return { id: p.uid, name: p.name, email: p.email, groups };
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

async function myItems(db, uid) {
  return (await db.query('USER#' + uid, 'ITEM#')).sort(sortItems).map((i) => itemOut(i, uid));
}

async function addItems(db, uid, b) {
  const raw = Array.isArray(b.items) ? b.items.slice(0, 100) : [b];
  const have = (await db.query('USER#' + uid, 'ITEM#')).length;
  const items = raw.map((r) => cleanItem(r || {}, uid)).filter(Boolean);
  if (!items.length) fail(400, 'Give it a name, a link or a photo');
  if (have + items.length > MAX_ITEMS) fail(400, `Lists hold up to ${MAX_ITEMS} things`);
  const t = Date.now();
  const saved = [];
  for (const [k, it] of items.entries()) {
    const id = newId();
    const row = { pk: 'USER#' + uid, sk: 'ITEM#' + id, id, owner: uid, ...it, createdAt: new Date(t + k).toISOString(), v: 1 };
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
  const next = { ...row, ...it, v: row.v + 1, updatedAt: now() };
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
  const meta = { pk: 'GROUP#' + id, sk: 'META', id, name, code, ownerId: p.uid, budget: line(b.budget, 30), date: cleanDate(b.date), notes: text(b.notes, 600), rules: { households: {}, exclusions: [], noPairs: false }, drawnAt: null, createdAt: now(), v: 1 };
  await db.put(meta);
  await join(db, p, meta);
  return { id };
}
const cleanDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : '');

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
  await Promise.all(ms.map(async (m) => { counts[m.uid] = (await db.query('USER#' + m.uid, 'ITEM#')).length; }));
  const draw = meta.drawnAt ? await db.get('GROUP#' + gid, 'DRAW#' + uid) : null;
  const drawnIds = meta.drawnAt ? new Set((await db.query('GROUP#' + gid, 'DRAW#')).map((d) => d.giver)) : null;
  const byId = Object.fromEntries(ms.map((m) => [m.uid, m]));
  return {
    id: meta.id, name: meta.name, code: meta.code, budget: meta.budget, date: meta.date, notes: meta.notes,
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
  const items = (await db.query('USER#' + who, 'ITEM#')).sort(sortItems).map((i) => itemOut(i, uid));
  return { id: who, name: m.name, items, yours: who === uid };
}

async function setBought(db, claims, gid, owner, id, on) {
  const uid = claims.sub;
  await groupFor(db, gid, uid);
  if (owner === uid) fail(400, "That's your own list — no peeking!");
  if (!(await db.get('GROUP#' + gid, 'MEMBER#' + owner))) fail(404, 'Not in this group');
  const row = await db.get('USER#' + owner, 'ITEM#' + id);
  if (!row) fail(404, 'That item was removed');
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
  if (a === 'me' && is('GET', 1)) return getMe(db, claims);
  if (a === 'me' && is('PUT', 1)) return putMe(db, claims, b);
  if (a === 'items') {
    await profile(db, claims);
    if (is('GET', 1)) return { items: await myItems(db, uid) };
    if (is('POST', 1)) return addItems(db, uid, b);
    if (is('PUT', 2)) return editItem(db, uid, x, b);
    if (is('DELETE', 2)) return deleteItem(db, uid, x);
  }
  if (a === 'uploads' && is('POST', 1)) return newUpload(uid, b);
  if (a === 'shopping' && is('GET', 1)) return { items: await shopping(db, uid) };
  if (a === 'join' && is('POST', 1)) return joinByCode(db, claims, b);
  if (a === 'groups') {
    if (is('POST', 1)) return createGroup(db, claims, b);
    if (is('GET', 2)) return getGroup(db, uid, x);
    if (is('PUT', 2)) return putGroup(db, uid, x, b);
    if (is('DELETE', 2)) return deleteGroup(db, uid, x);
    if (y === 'members' && is('DELETE', 4)) return removeMember(db, uid, x, z);
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
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (!claims?.sub) fail(401, 'Sign in first');
    const method = event.requestContext.http.method;
    const parts = (event.rawPath || '/').split('/').filter(Boolean).map(decodeURIComponent);
    const b = ['POST', 'PUT'].includes(method) ? parseBody(event) : {};
    const db = await store();
    return reply(event, 200, await route(db, claims, method, parts, b));
  } catch (e) {
    if (e instanceof HttpError) return reply(event, e.code, { error: e.message });
    console.error(e);
    return reply(event, 500, { error: 'Something went wrong on our side' });
  }
};
