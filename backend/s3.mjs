// Presigned S3 URLs for item photos, signed by hand (SigV4 query signing) so the
// Lambda needs no extra packages. The bucket stays private; browsers upload with
// a short-lived PUT URL and view with a short-lived GET URL.
import crypto from 'node:crypto';

const BUCKET = process.env.PHOTO_BUCKET;
const REGION = process.env.AWS_REGION || 'us-east-1';
const HOST = `${BUCKET}.s3.${REGION}.amazonaws.com`;

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function presign(method, key, expires = 900, contentType) {
  if (process.env.MEMORY_STORE) return `/dev-photos/${key}`; // local dev server stores photos itself
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const path = '/' + key.split('/').map(enc).join('/');
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${process.env.AWS_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': contentType ? 'content-type;host' : 'host',
  };
  if (process.env.AWS_SESSION_TOKEN) q['X-Amz-Security-Token'] = process.env.AWS_SESSION_TOKEN;
  const query = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const headers = contentType ? `content-type:${contentType}\nhost:${HOST}\n` : `host:${HOST}\n`;
  const canonical = [method, path, query, headers, q['X-Amz-SignedHeaders'], 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
  const kSign = hmac(hmac(hmac(hmac('AWS4' + process.env.AWS_SECRET_ACCESS_KEY, day), REGION), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
  return `https://${HOST}${path}?${query}&X-Amz-Signature=${sig}`;
}

export async function deletePhoto(key) {
  if (!key || process.env.MEMORY_STORE) return;
  try { await fetch(presign('DELETE', key, 60), { method: 'DELETE' }); } catch (e) { console.error('photo delete failed', e); }
}
