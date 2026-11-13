// Live updates over the WebSocket API. Each open socket is stored twice:
//   USER#<sub> / CONN#<id>   so we can find a person's sockets
//   CONN#<id>  / META        so $disconnect can find the person
// Messages only say *what changed*; browsers refetch through the HTTP API,
// which applies the privacy rules (e.g. you never learn what was bought for you).
import crypto from 'node:crypto';
import { store } from './store.mjs';

const REGION = process.env.AWS_REGION || 'us-east-1';
const POOL = process.env.USER_POOL_ID;
const CLIENT = process.env.CLIENT_ID;
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;
const CONN_TTL = 3 * 3600; // API Gateway closes sockets after 2 h anyway

export const sent = []; // memory-store mode records messages here for tests

// Cognito ID token check (RS256 against the pool's JWKS), same as ICYN's ws Lambda.
let jwks = null;
export async function verifyIdToken(token) {
  const [h, p, s] = String(token || '').split('.');
  if (!s) return null;
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  if (header.alg !== 'RS256') return null;
  if (!jwks) jwks = (await (await fetch(`${ISSUER}/.well-known/jwks.json`)).json()).keys;
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url'));
  if (c.iss !== ISSUER || c.aud !== CLIENT || c.token_use !== 'id' || c.exp * 1000 < Date.now()) return null;
  return c;
}

export async function handleSocket(event) {
  const db = await store();
  const { eventType, connectionId } = event.requestContext;
  if (eventType === 'CONNECT') {
    const claims = await verifyIdToken(event.queryStringParameters?.token).catch(() => null);
    if (!claims) return { statusCode: 401 };
    const ttl = Math.floor(Date.now() / 1000) + CONN_TTL;
    await db.put({ pk: 'USER#' + claims.sub, sk: 'CONN#' + connectionId, connectionId, ttl });
    await db.put({ pk: 'CONN#' + connectionId, sk: 'META', userId: claims.sub, ttl });
    return { statusCode: 200 };
  }
  if (eventType === 'DISCONNECT') {
    const c = await db.get('CONN#' + connectionId, 'META');
    if (c) await db.del('USER#' + c.userId, 'CONN#' + connectionId);
    await db.del('CONN#' + connectionId, 'META');
    return { statusCode: 200 };
  }
  return { statusCode: 200 }; // {action:'ping'} keep-alive
}

let api = null;
async function post(connectionId, msg) {
  if (process.env.MEMORY_STORE) { sent.push({ connectionId, msg }); return true; }
  if (!api) {
    const { ApiGatewayManagementApiClient } = await import('@aws-sdk/client-apigatewaymanagementapi');
    api = new ApiGatewayManagementApiClient({ endpoint: process.env.WS_ENDPOINT });
  }
  const { PostToConnectionCommand } = await import('@aws-sdk/client-apigatewaymanagementapi');
  try {
    await api.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify(msg) }));
    return true;
  } catch (e) {
    if (e.name === 'GoneException') return false;
    console.error(e);
    return true;
  }
}

// Tell these people something changed. Never throws: live updates are a bonus.
export async function notify(userIds, msg) {
  try {
    const db = await store();
    await Promise.all([...new Set(userIds)].map(async (uid) => {
      const conns = await db.query('USER#' + uid, 'CONN#');
      await Promise.all(conns.map(async (c) => {
        const alive = await post(c.connectionId, msg);
        if (!alive) {
          await db.del('USER#' + uid, 'CONN#' + c.connectionId);
          await db.del('CONN#' + c.connectionId, 'META');
        }
      }));
    }));
  } catch (e) { console.error('notify failed', e); }
}
