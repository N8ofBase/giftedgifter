// Link lookup: fetch a product page and pull out its name, price and main photo
// (Open Graph tags, schema.org Product data, or the <title>). Used to fill in an
// item as soon as someone pastes a link.
//
// Safety: http/https on standard ports only, every hop (redirects included) must
// resolve to a public IP address, 6-second timeout, and the page and photo are
// size-capped.
import dns from 'node:dns/promises';
import net from 'node:net';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 GiftedGifter/1.0';
const MAX_HTML = 1_500_000;
const MAX_IMAGE = 5_000_000;

export function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateIp(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

async function checkUrl(u) {
  const x = new URL(u);
  if (!['http:', 'https:'].includes(x.protocol)) throw new Error('bad protocol');
  if (x.port && !['80', '443'].includes(x.port)) throw new Error('bad port');
  if (x.username || x.password) throw new Error('credentials in url');
  const host = x.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (!addrs.length || addrs.some(privateIp)) throw new Error('private address');
  return x;
}

async function safeFetch(u, accept) {
  let url = u;
  for (let hop = 0; hop < 4; hop++) {
    await checkUrl(url);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.9' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).href;
      continue;
    }
    return { res, url };
  }
  throw new Error('too many redirects');
}

async function readCapped(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel(); break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const decode = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

function meta(html, names) {
  for (const n of names) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${n}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && decode(m[1])) return decode(m[1]);
  }
  return '';
}

function productFromJsonLd(html) {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  const found = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    const t = [].concat(o['@type'] || []);
    if (t.some((x) => /Product/i.test(x))) found.push(o);
    if (o['@graph']) walk(o['@graph']);
  };
  for (const b of blocks) {
    try { walk(JSON.parse(b.replace(/^<script[^>]*>|<\/script>$/gi, ''))); } catch { /* skip bad JSON */ }
  }
  const p = found[0];
  if (!p) return {};
  const offer = [].concat(p.offers || [])[0] || {};
  const price = offer.price ?? offer.lowPrice ?? (offer.priceSpecification && offer.priceSpecification.price);
  const image = [].concat(p.image || [])[0];
  return { name: decode(p.name), price, currency: offer.priceCurrency, image: typeof image === 'string' ? image : image && image.url };
}

function cleanTitle(t, host) {
  let s = decode(t).replace(/^Amazon\.com\s*:\s*/i, '').replace(/\s*:\s*[A-Z][\w &,'-]{2,40}$/, '');
  const site = host.replace(/^www\./, '').split('.')[0].toLowerCase();
  const parts = s.split(/\s+[|–—-]\s+/);
  if (parts.length > 1 && parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g, '').includes(site)) parts.pop();
  return parts.join(' - ').trim().slice(0, 140);
}

function fmtPrice(p, cur) {
  const n = Number(String(p ?? '').replace(/[^0-9.]/g, ''));
  if (!n || !isFinite(n)) return '';
  const v = n % 1 ? n.toFixed(2) : String(n);
  return !cur || cur === 'USD' ? '$' + v : `${v} ${cur}`;
}

export function parsePage(html, url) {
  const host = new URL(url).hostname;
  const ld = productFromJsonLd(html);
  const rawTitle = ld.name || meta(html, ['og:title', 'twitter:title']) || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  const title = cleanTitle(rawTitle, host);
  if (!title || /robot|captcha|access denied|just a moment|page not found|sign in/i.test(title)) return {};
  const price = fmtPrice(ld.price ?? meta(html, ['product:price:amount', 'og:price:amount']), ld.currency || meta(html, ['product:price:currency', 'og:price:currency']));
  const img = ld.image || meta(html, ['og:image:secure_url', 'og:image', 'twitter:image']);
  return { title, price, imageUrl: img ? new URL(img, url).href : '' };
}

// Returns { title, price, imageUrl } (any may be empty). Never throws.
export async function unfurl(link) {
  try {
    const { res, url } = await safeFetch(link, 'text/html,application/xhtml+xml');
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) return {};
    return parsePage((await readCapped(res, MAX_HTML)).toString('utf8'), url);
  } catch (e) {
    console.log('unfurl failed', link, e.message);
    return {};
  }
}

// Download a product photo (≤5 MB, jpeg/png/webp). Returns { body, type } or null.
export async function fetchImage(u) {
  try {
    const { res } = await safeFetch(u, 'image/avif,image/webp,image/png,image/jpeg,*/*');
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) return null;
    const body = await readCapped(res, MAX_IMAGE + 1);
    if (body.length > MAX_IMAGE || body.length < 500) return null;
    return { body, type };
  } catch (e) {
    console.log('image fetch failed', u, e.message);
    return null;
  }
}
