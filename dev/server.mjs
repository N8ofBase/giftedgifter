// Local development server: serves site/ and runs the Lambda in-process with an
// in-memory database. Sign-in is faked (any name you type). No AWS needed.
//   node dev/server.mjs   → http://localhost:8080
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MEMORY_STORE = '1';
const { handler } = await import('../backend/index.mjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = Number(process.env.PORT || 8080);
const photos = new Map();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

  const photo = url.pathname.match(/^(?:\/api)?\/dev-photos\/(.+)$/);
  if (photo) {
    if (req.method === 'PUT') { photos.set(photo[1], body); res.writeHead(200); return res.end(); }
    const b = photos.get(photo[1]);
    res.writeHead(b ? 200 : 404, { 'content-type': 'image/jpeg' });
    return res.end(b);
  }

  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end("window.GG_CONFIG = { dev: true, api: '/api', ws: '' };");
  }

  if (url.pathname.startsWith('/api/')) {
    const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
    let claims = null;
    try { claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url')); } catch {}
    const out = await handler({
      rawPath: url.pathname.slice(4), headers: req.headers, body: body.length ? body.toString('utf8') : undefined,
      requestContext: { http: { method: req.method }, authorizer: claims ? { jwt: { claims } } : undefined },
    });
    res.writeHead(out.statusCode, out.headers);
    return res.end(out.body);
  }

  const file = path.join(root, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(PORT, () => console.log(`Gifted Gifter dev → http://localhost:${PORT}`));
