// Sign-in for Gifted Gifter via Amazon Cognito managed login
// (OAuth 2.0 authorization code + PKCE) — same pattern as I Crit You Not!.
// Exposes window.GGAuth: signIn(), signUp(), signOut(), user(), idToken(), onChange(fn), ready.
(function () {
  const CONFIG = window.GG_CONFIG;
  const KEY = 'gg.auth';
  const VERIFIER = 'gg.pkce';
  const listeners = [];
  const redirectUri = location.origin + '/';

  const b64url = (bytes) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; } }
  function save(t) {
    try { t ? localStorage.setItem(KEY, JSON.stringify(t)) : localStorage.removeItem(KEY); } catch (e) {}
    listeners.forEach((fn) => { try { fn(user()); } catch (e) {} });
  }
  function claims(jwt) {
    try {
      const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    } catch (e) { return null; }
  }

  async function startFlow(path) {
    if (CONFIG.dev) return devSignIn();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    // localStorage (not sessionStorage) so sign-up survives in-app browsers and new tabs.
    localStorage.setItem(VERIFIER, JSON.stringify({ verifier, state }));
    const q = new URLSearchParams({
      response_type: 'code', client_id: CONFIG.clientId, redirect_uri: redirectUri,
      scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    location.assign(`${CONFIG.authDomain}/${path}?${q}`);
  }

  // Local development only (config.dev): an unsigned token the dev server trusts.
  function devSignIn() {
    const name = prompt('Dev sign-in — your name?');
    if (!name) return;
    const sub = 'dev-' + name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const enc = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const id = `${enc({ alg: 'none' })}.${enc({ sub, name, email: sub + '@example.com', exp: Date.now() / 1000 + 86400 })}.dev`;
    save({ id_token: id, expires_at: Date.now() + 86400000 });
    location.reload();
  }

  async function token(body) {
    const res = await fetch(`${CONFIG.authDomain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CONFIG.clientId, ...body }),
    });
    if (!res.ok) throw new Error('Token request failed: ' + res.status);
    const t = await res.json();
    return { ...t, expires_at: Date.now() + t.expires_in * 1000 };
  }

  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    const code = q.get('code');
    if (!code) return;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(VERIFIER) || sessionStorage.getItem(VERIFIER) || 'null'); } catch (e) {}
    localStorage.removeItem(VERIFIER); sessionStorage.removeItem(VERIFIER);
    history.replaceState(null, '', location.pathname + location.hash);
    if (!saved || saved.state !== q.get('state')) return;
    save(await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: saved.verifier }));
  }

  async function refreshIfNeeded() {
    const t = load();
    if (!t || Date.now() < t.expires_at - 60000) return;
    if (!t.refresh_token) return save(null);
    try {
      const n = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
      save({ ...n, refresh_token: t.refresh_token });
    } catch (e) { save(null); }
  }

  function user() {
    const t = load();
    const c = t && claims(t.id_token);
    if (!c) return null;
    return { id: c.sub, email: c.email, name: c.name || c.nickname || (c.email || '').split('@')[0] };
  }

  window.GGAuth = {
    signIn: () => startFlow('oauth2/authorize'),
    signUp: () => startFlow('signup'),
    signOut() {
      save(null);
      if (CONFIG.dev) return location.reload();
      location.assign(`${CONFIG.authDomain}/logout?${new URLSearchParams({ client_id: CONFIG.clientId, logout_uri: redirectUri })}`);
    },
    user,
    async idToken() { await refreshIfNeeded(); const t = load(); return t ? t.id_token : null; },
    onChange(fn) { listeners.push(fn); },
    ready: handleRedirect().then(refreshIfNeeded).catch(() => {}),
  };
})();
