// Gifted Gifter — the whole web app (no build step).
(function () {
  const CFG = window.GG_CONFIG;
  const Auth = window.GGAuth;
  const $view = document.getElementById('view');
  let me = null;          // {id, name, email, groups}
  let currentRender = null;

  // ---------- tiny DOM helper (text is always set as text, never HTML) ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
    return el;
  }
  const initials = (n) => (n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const hue = (s) => { let x = 0; for (const c of s || '') x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
  const avatar = (name, id) => h('div', { class: 'avatar', style: `background:hsl(${hue(id || name)} 38% 38%)` }, initials(name));
  const fmtDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const daysUntil = (d) => d ? Math.ceil((new Date(d + 'T12:00:00') - new Date()) / 86400000) : null;
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };

  function toast(msg, err) {
    const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), err ? 5000 : 2600);
  }

  // ---------- API ----------
  async function api(method, path, body) {
    const token = await Auth.idToken();
    if (!token) { Auth.signIn(); throw new Error('Please sign in'); }
    const res = await fetch(CFG.api + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || 'Something went wrong');
    return data;
  }
  // Runs an action, shows any error, and returns true when it worked.
  async function act(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); return true; } catch (e) { toast(e.message, true); return false; }
  }

  // ---------- live updates ----------
  const live = { sock: null, tries: 0, ping: null, timer: null };
  async function connectLive() {
    if (!CFG.ws || live.sock) return;
    const token = await Auth.idToken();
    if (!token) return;
    const s = new WebSocket(CFG.ws + '?token=' + encodeURIComponent(token));
    live.sock = s;
    s.onopen = () => { live.tries = 0; setLiveDot(true); live.ping = setInterval(() => s.readyState === 1 && s.send('{"action":"ping"}'), 8 * 60000); };
    s.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (msg.type !== 'changed') return;
      clearTimeout(live.timer);
      live.timer = setTimeout(() => refresh(msg), 250); // bursts collapse into one refetch
    };
    s.onclose = () => {
      clearInterval(live.ping); live.sock = null; setLiveDot(false);
      const wait = Math.min(30000, 1000 * 2 ** live.tries++);
      setTimeout(connectLive, wait);
    };
  }
  function setLiveDot(on) { document.querySelectorAll('.live-dot').forEach((d) => d.classList.toggle('on', on)); }
  async function refresh(msg) {
    if (msg && msg.drawn) toast('🎁 Names have been drawn!');
    if (msg && msg.scope === 'group') me = await api('GET', '/me').catch(() => me);
    if (currentRender && !document.querySelector('.modal-back')) currentRender(true);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && me) { connectLive(); refresh(); } });

  // ---------- router ----------
  const routes = [
    [/^#?\/?$/, viewHome],
    [/^#\/list$/, viewMyList],
    [/^#\/shopping$/, viewShopping],
    [/^#\/me$/, viewMe],
    [/^#\/join\/([A-Za-z0-9]+)$/, viewJoin],
    [/^#\/g\/([\w-]+)$/, viewGroup],
    [/^#\/g\/([\w-]+)\/u\/([\w|.@-]+)$/, viewMember],
  ];
  async function go() {
    const hash = location.hash || '#/';
    document.querySelectorAll('.modal-back').forEach((m) => m.remove());
    for (const [re, fn] of routes) {
      const m = hash.match(re);
      if (!m) continue;
      const nav = hash.startsWith('#/list') ? 'list' : hash.startsWith('#/shopping') ? 'shopping' : hash.startsWith('#/me') ? 'me' : 'home';
      document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
      currentRender = (quiet) => fn(...m.slice(1), quiet);
      if (!fn.noLoading) $view.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
      window.scrollTo(0, 0);
      try { await currentRender(false); } catch (e) { $view.replaceChildren(errorBox(e)); }
      return;
    }
    location.hash = '#/';
  }
  const errorBox = (e) => h('div', { class: 'empty' }, h('div', { class: 'emoji' }, '🧭'), h('p', {}, e.message), h('a', { class: 'btn ghost', href: '#/' }, 'Back to your groups'));
  // Re-render without losing the scroll position.
  function paint(...nodes) { const y = window.scrollY; $view.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false && n !== '')); window.scrollTo(0, y); }

  // ---------- landing ----------
  function landing() {
    document.getElementById('top').hidden = true;
    $view.replaceChildren(
      h('section', { class: 'hero' },
        h('img', { class: 'logo', src: 'icon.svg', alt: '' }),
        h('h1', {}, 'Gifted Gifter'),
        h('p', { class: 'lead' }, 'Private wish lists and secret gift draws for your family and friends. Nobody double-buys, and nobody spoils the surprise.'),
        h('div', { class: 'row' },
          h('button', { onclick: () => Auth.signUp() }, 'Create an account'),
          h('button', { class: 'ghost', onclick: () => Auth.signIn() }, 'Sign in'))),
      h('div', { class: 'features' },
        feature('📝', 'Your list, your way', 'Type an idea, paste a link from any store, or snap a photo of the thing you want.'),
        feature('🎩', 'Draw names', 'Secret assignments with rules — spouses and housemates never draw each other.'),
        feature('🤫', 'Surprise stays safe', 'Gifters mark what they bought. You never see what\'s been bought for you.'),
        feature('⚡', 'Always up to date', 'Lists and purchases update live for everyone in the group.')));
  }
  const feature = (e, t, p) => h('div', { class: 'card' }, h('div', { class: 'emoji' }, e), h('h3', {}, t), h('p', {}, p));

  // ---------- home: groups ----------
  async function viewHome(quiet) {
    if (!quiet || !me) me = await api('GET', '/me');
    const groups = me.groups;
    paint(
      h('div', { class: 'row between' },
        h('div', {}, h('h1', {}, `Hi, ${me.name.split(' ')[0]}`), h('p', { class: 'muted' }, 'Your gift exchange groups ', h('span', { class: 'live-dot' + (live.sock && live.sock.readyState === 1 ? ' on' : ''), title: 'Live updates' })))),
      groups.length
        ? h('div', { class: 'grid' }, groups.map((g) => h('a', { class: 'card group-card', href: '#/g/' + g.id },
            h('h3', {}, g.name),
            h('div', { class: 'row' },
              h('span', { class: 'pill' }, `${g.members} ${g.members === 1 ? 'person' : 'people'}`),
              g.date && h('span', { class: 'pill gold' }, countdown(g.date)),
              g.drawn ? h('span', { class: 'pill green' }, 'Names drawn') : null,
              g.admin ? h('span', { class: 'pill' }, 'Organizer') : null))))
        : h('div', { class: 'empty' }, h('div', { class: 'emoji' }, '🎄'), h('p', {}, 'No groups yet. Start one for your family or friends, or join with an invite code.')),
      h('div', { class: 'section grid' },
        h('div', { class: 'card stack' }, h('h2', {}, 'Start a group'), h('p', { class: 'muted small' }, 'You\'ll be the organizer — you can invite people and draw names.'), h('button', { onclick: newGroupModal }, '+ New group')),
        joinCard()),
      h('div', { class: 'section card row between' },
        h('div', {}, h('h3', {}, 'Your wish list'), h('p', { class: 'muted small', style: 'margin:0' }, 'One list, shared with everyone in your groups.')),
        h('a', { class: 'btn ghost', href: '#/list' }, 'Edit my list')));
  }
  function countdown(d) {
    const n = daysUntil(d);
    if (n == null) return '';
    if (n > 1) return `${n} days to go`;
    if (n === 1) return 'Tomorrow!';
    if (n === 0) return 'Today!';
    return fmtDate(d);
  }
  function joinCard() {
    const input = h('input', { placeholder: 'Invite code', autocapitalize: 'characters', maxlength: 12, style: 'text-transform:uppercase' });
    const join = () => act(async () => { const r = await api('POST', '/join', { code: input.value }); me = await api('GET', '/me'); location.hash = '#/g/' + r.id; });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && join());
    return h('div', { class: 'card stack' }, h('h2', {}, 'Join a group'), h('p', { class: 'muted small' }, 'Got a code from the organizer? Enter it here.'),
      h('div', { class: 'row', style: 'flex-wrap:nowrap' }, input, h('button', { onclick: join }, 'Join')));
  }

  function modal(title, body, buttons) {
    const back = h('div', { class: 'modal-back', onclick: (e) => e.target === back && close() });
    const close = () => back.remove();
    back.append(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', {}, title), body, h('div', { class: 'row end' }, h('button', { class: 'ghost', onclick: close }, 'Cancel'), ...(buttons(close) || []))));
    document.body.append(back);
    const first = back.querySelector('input,textarea');
    if (first && matchMedia('(min-width: 640px)').matches) first.focus();
    return close;
  }

  function newGroupModal() {
    const f = groupFields({});
    modal('New group', f.el, (close) => [h('button', { onclick: (e) => act(async () => {
      e.target.disabled = true;
      try { const r = await api('POST', '/groups', f.value()); me = await api('GET', '/me'); close(); location.hash = '#/g/' + r.id; }
      finally { e.target.disabled = false; }
    }) }, 'Create group')]);
  }
  function groupFields(g) {
    const name = h('input', { value: g.name || '', placeholder: 'Sloan Family Christmas', maxlength: 60 });
    const date = h('input', { type: 'date', value: g.date || '' });
    const budget = h('input', { value: g.budget || '', placeholder: '$50', maxlength: 30 });
    const notes = h('textarea', { placeholder: 'Anything everyone should know — where you\'re meeting, theme, etc.', maxlength: 600 }, g.notes || '');
    return {
      el: h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'Group name'), name),
        h('div', { class: 'fields-2 field' }, h('div', {}, h('label', {}, 'Exchange date'), date), h('div', {}, h('label', {}, 'Budget'), budget)),
        h('div', { class: 'field' }, h('label', {}, 'Notes'), notes)),
      value: () => ({ name: name.value, date: date.value, budget: budget.value, notes: notes.value }),
    };
  }

  // ---------- join by link ----------
  async function viewJoin(code) {
    const r = await api('POST', '/join', { code });
    me = await api('GET', '/me');
    toast('You\'re in! 🎉');
    location.replace('#/g/' + r.id);
  }

  // ---------- group ----------
  async function viewGroup(gid, quiet) {
    const g = await api('GET', '/groups/' + gid);
    const link = `${location.origin}/#/join/${g.code}`;
    const share = async () => {
      if (navigator.share) { try { await navigator.share({ title: g.name, text: `Join "${g.name}" on Gifted Gifter`, url: link }); return; } catch (e) { if (e.name === 'AbortError') return; } }
      await navigator.clipboard.writeText(link); toast('Invite link copied');
    };
    const notInDraw = g.drawnAt ? g.members.filter((m) => !m.inDraw) : [];
    paint(
      h('a', { class: 'back', href: '#/' }, '← All groups'),
      h('h1', {}, g.name),
      h('div', { class: 'row' },
        g.date && h('span', { class: 'pill gold' }, `${fmtDate(g.date)} · ${countdown(g.date)}`),
        g.budget && h('span', { class: 'pill' }, 'Budget ' + g.budget),
        h('span', { class: 'pill' }, `${g.members.length} people`)),
      g.notes && h('p', { class: 'muted', style: 'margin-top:12px;white-space:pre-wrap' }, g.notes),
      h('div', { class: 'section' }, g.giftingTo ? assignment(g) : h('div', { class: 'card' },
        h('h3', {}, g.drawnAt ? 'You joined after the draw' : 'Names haven\'t been drawn yet'),
        h('p', { class: 'muted small', style: 'margin:0' }, g.drawnAt ? 'Ask the organizer to redraw so you\'re included.' : (g.admin ? 'When everyone has joined, draw names below.' : 'The organizer will draw names once everyone has joined. You can still browse lists and mark things bought.')))),
      h('div', { class: 'section card' },
        h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'People'), h('span', { class: 'live-dot' + (live.sock && live.sock.readyState === 1 ? ' on' : ''), title: 'Live updates' })),
        h('div', {}, g.members.map((m) => h('a', { class: 'member', href: m.id === g.you ? '#/list' : `#/g/${gid}/u/${m.id}` },
          avatar(m.name, m.id),
          h('div', { class: 'grow' },
            h('div', { class: 'name' }, m.name, m.id === g.you ? ' (you)' : '', m.id === g.ownerId ? ' · organizer' : ''),
            h('div', { class: 'muted small' }, m.items ? `${m.items} on their list` : 'No list yet')),
          h('span', { class: 'muted' }, '›'))))),
      h('div', { class: 'section card stack' },
        h('h2', {}, 'Invite people'),
        h('p', { class: 'muted small' }, 'Share the link, or have them enter the code on their Groups page.'),
        h('div', { class: 'row' }, h('span', { class: 'code-box' }, g.code), h('button', { onclick: share }, 'Share invite link'))),
      g.admin ? adminPanel(g, notInDraw) : h('div', { class: 'section' }, h('button', { class: 'danger-text', onclick: () => leaveGroup(g) }, 'Leave this group')));
  }

  function assignment(g) {
    const key = 'gg.revealed.' + g.id + '.' + g.drawnAt;
    let shown = localStorage.getItem(key) === '1';
    const name = h('div', { class: 'reveal' + (shown ? '' : ' hidden-name'), title: 'Tap to reveal' }, g.giftingTo.name);
    const btn = h('button', { class: 'ghost small' }, shown ? 'Hide' : 'Reveal');
    const toggle = () => { shown = !shown; localStorage.setItem(key, shown ? '1' : '0'); name.classList.toggle('hidden-name', !shown); btn.textContent = shown ? 'Hide' : 'Reveal'; };
    name.onclick = () => !shown && toggle();
    btn.onclick = toggle;
    return h('div', { class: 'card gift-banner' },
      h('h2', {}, '🎁 You\'re gifting to'), name,
      h('div', { class: 'row' }, h('a', { class: 'btn', style: 'background:#fff;color:var(--pine)', href: `#/g/${g.id}/u/${g.giftingTo.id}` }, 'See their list'), btn),
      h('p', { class: 'small', style: 'margin:12px 0 0;opacity:.8' }, 'Only you can see this.'));
  }

  function adminPanel(g, notInDraw) {
    const rules = g.rules || { households: {}, exclusions: [], noPairs: false };
    const labels = [...new Set(Object.values(rules.households))];
    const dl = h('datalist', { id: 'hh-labels' }, labels.map((l) => h('option', { value: l })));
    const hhInputs = {};
    const hhRows = g.members.map((m) => {
      const i = h('input', { value: rules.households[m.id] || '', placeholder: 'e.g. Sloans', list: 'hh-labels', maxlength: 30 });
      hhInputs[m.id] = i;
      return h('div', { class: 'rule-row' }, h('div', { class: 'row', style: 'flex-wrap:nowrap' }, avatar(m.name, m.id), h('span', {}, m.name)), i);
    });
    let ex = rules.exclusions.slice();
    const nameOf = (id) => (g.members.find((m) => m.id === id) || {}).name || 'Someone who left';
    const exList = h('div');
    const drawEx = () => exList.replaceChildren(...(ex.length ? ex.map((p, i) => h('div', { class: 'ex-row' }, h('span', {}, `${nameOf(p[0])} ↔ ${nameOf(p[1])}`), h('button', { class: 'danger-text', onclick: () => { ex.splice(i, 1); drawEx(); } }, 'Remove'))) : [h('p', { class: 'muted small' }, 'None yet.')]));
    drawEx();
    const opts = () => g.members.map((m) => h('option', { value: m.id }, m.name));
    const a = h('select', {}, opts()), b = h('select', {}, opts());
    if (g.members[1]) b.value = g.members[1].id;
    const noPairs = h('input', { type: 'checkbox', checked: !!rules.noPairs });
    const value = () => ({
      households: Object.fromEntries(Object.entries(hhInputs).map(([k, i]) => [k, i.value.trim()]).filter(([, v]) => v)),
      exclusions: ex, noPairs: noPairs.checked,
    });
    const saveRules = () => api('PUT', '/groups/' + g.id, { rules: value() });

    return h('details', { class: 'section card admin', open: !g.drawnAt },
      h('summary', {}, 'Organizer tools'),
      h('div', { class: 'stack', style: 'margin-top:14px' },
        h('h3', {}, 'Households'),
        h('p', { class: 'muted small' }, 'People with the same household label never draw each other — use it for spouses, partners, or anyone who lives together.'),
        dl, h('div', {}, hhRows),
        h('h3', { style: 'margin-top:20px' }, 'Never pair'),
        h('p', { class: 'muted small' }, 'Any two people who shouldn\'t draw each other for another reason.'),
        exList,
        h('div', { class: 'row', style: 'flex-wrap:nowrap' }, a, h('span', {}, '↔'), b,
          h('button', { class: 'ghost small', onclick: () => { if (a.value === b.value) return toast('Pick two different people', true); if (!ex.some((p) => p.includes(a.value) && p.includes(b.value))) ex.push([a.value, b.value]); drawEx(); } }, 'Add')),
        h('label', { class: 'check', style: 'margin-top:12px' }, noPairs, 'Avoid swaps (A draws B and B draws A)'),
        h('div', { class: 'row' }, h('button', { class: 'ghost', onclick: () => act(async () => { await saveRules(); currentRender(true); }, 'Rules saved') }, 'Save rules')),
        h('h3', { style: 'margin-top:20px' }, 'Draw names'),
        g.drawnAt
          ? h('div', {},
              h('p', { class: 'small' }, `Drawn ${new Date(g.drawnAt).toLocaleString()}. Each person sees only their own match.`),
              notInDraw.length ? h('p', { class: 'small pill berry' }, `Not in the draw: ${notInDraw.map((m) => m.name).join(', ')}`) : null,
              h('div', { class: 'row', style: 'margin-top:8px' },
                h('button', { class: 'gold', onclick: () => confirmDraw(true) }, 'Redraw everyone'),
                h('button', { class: 'ghost', onclick: () => confirm('Clear the draw? Everyone loses their match.') && act(async () => { await api('DELETE', `/groups/${g.id}/draw`); currentRender(true); }, 'Draw cleared') }, 'Clear draw')))
          : h('div', {},
              h('p', { class: 'small muted' }, g.members.length < 3 ? 'You need at least 3 people.' : `Ready with ${g.members.length} people. Your rules are saved first.`),
              h('button', { class: 'gold', disabled: g.members.length < 3, onclick: () => confirmDraw(false) }, '🎩 Draw names')),
        h('h3', { style: 'margin-top:20px' }, 'Group details'),
        h('div', { class: 'row' },
          h('button', { class: 'ghost small', onclick: () => editGroupModal(g) }, 'Edit details'),
          h('button', { class: 'ghost small', onclick: () => removePeopleModal(g) }, 'Remove someone'),
          h('button', { class: 'danger-text', onclick: () => confirm(`Delete "${g.name}" for everyone? Lists stay, but the group and draw are gone.`) && act(async () => { await api('DELETE', '/groups/' + g.id); location.hash = '#/'; }, 'Group deleted') }, 'Delete group'))));

    function confirmDraw(again) {
      if (!confirm(again ? 'Redraw? Everyone gets a new match — let people know!' : `Draw names for ${g.members.length} people now?`)) return;
      act(async () => { await saveRules(); await api('POST', `/groups/${g.id}/draw`); currentRender(true); }, 'Names drawn! 🎉');
    }
  }
  function editGroupModal(g) {
    const f = groupFields(g);
    modal('Edit group', f.el, (close) => [h('button', { onclick: () => act(async () => { await api('PUT', '/groups/' + g.id, f.value()); close(); currentRender(true); }, 'Saved') }, 'Save')]);
  }
  function removePeopleModal(g) {
    const others = g.members.filter((m) => m.id !== g.ownerId);
    const body = h('div', {}, others.length ? others.map((m) => h('div', { class: 'ex-row' }, h('span', {}, m.name),
      h('button', { class: 'danger-text', onclick: (e) => confirm(`Remove ${m.name} from ${g.name}?`) && act(async () => { await api('DELETE', `/groups/${g.id}/members/${encodeURIComponent(m.id)}`); e.target.closest('.ex-row').remove(); }, 'Removed') }, 'Remove')))
      : h('p', { class: 'muted' }, 'Nobody else is in the group yet.'));
    modal('Remove someone', body, () => []);
  }
  function leaveGroup(g) {
    if (!confirm(`Leave ${g.name}?`)) return;
    act(async () => { await api('DELETE', `/groups/${g.id}/members/${encodeURIComponent(g.you)}`); me = await api('GET', '/me'); location.hash = '#/'; }, 'You left the group');
  }

  // ---------- someone else's list ----------
  async function viewMember(gid, uid) {
    const r = await api('GET', `/groups/${gid}/lists/${encodeURIComponent(uid)}`);
    if (r.yours) { location.hash = '#/list'; return; }
    const open = r.items.filter((i) => !i.bought), done = r.items.filter((i) => i.bought);
    paint(
      h('a', { class: 'back', href: '#/g/' + gid }, '← Back to group'),
      h('div', { class: 'row', style: 'flex-wrap:nowrap;margin-bottom:6px' }, avatar(r.name, r.id), h('h1', { style: 'margin:0' }, `${r.name}'s list`)),
      h('p', { class: 'muted' }, `${r.name} can't see what's been bought. Mark it when you buy something so nobody doubles up.`),
      r.items.length ? null : h('div', { class: 'empty' }, h('div', { class: 'emoji' }, '🤔'), h('p', {}, `${r.name} hasn't added anything yet. You'll see it here the moment they do.`)),
      open.length ? h('div', { class: 'items' }, open.map((i) => itemCard(i, { gid, owner: uid, ownerName: r.name }))) : null,
      done.length ? h('div', { class: 'section' }, h('h2', {}, 'Already bought'), h('div', { class: 'items' }, done.map((i) => itemCard(i, { gid, owner: uid, ownerName: r.name })))) : null);
  }

  // ---------- item card ----------
  function itemCard(i, ctx) {
    const photo = i.imageUrl ? h('div', { class: 'photo' }, h('img', { src: i.imageUrl, alt: i.title, loading: 'lazy' })) : h('div', { class: 'photo none' }, i.url ? '🔗' : '🎁');
    const meta = h('div', { class: 'meta' },
      i.priority === 2 && h('span', { class: 'pill berry' }, '★ Most wanted'),
      i.priority === 1 && h('span', { class: 'pill gold' }, 'Really want'),
      i.price && h('span', { class: 'pill' }, i.price),
      i.qty > 1 && h('span', { class: 'pill' }, `Wants ${i.qty}`));
    const actions = h('div', { class: 'actions' });
    if (ctx.mine) {
      actions.append(h('button', { class: 'ghost small', onclick: () => itemModal(i) }, 'Edit'),
        h('button', { class: 'danger-text', onclick: () => confirm(`Remove "${i.title}"?`) && act(async () => { await api('DELETE', '/items/' + i.id); currentRender(true); }, 'Removed') }, 'Remove'));
    } else if (ctx.gid) {
      const path = `/groups/${ctx.gid}/lists/${encodeURIComponent(ctx.owner)}/items/${i.id}/bought`;
      if (!i.bought) actions.append(h('button', { class: 'small', onclick: (e) => { e.target.disabled = true; act(async () => { await api('POST', path); currentRender(true); }, `Marked bought — it's on your Shopping page`).then(() => { e.target.disabled = false; }); } }, '✓ I bought this'));
      else if (i.bought.mine) actions.append(h('span', { class: 'bought-tag' }, '✓ You bought this'), h('button', { class: 'link', onclick: () => act(async () => { await api('DELETE', path); currentRender(true); }, 'Unmarked') }, 'Undo'));
      else actions.append(h('span', { class: 'bought-tag' }, `✓ Bought by ${i.bought.by}`));
    }
    return h('article', { class: 'card item' + (i.bought ? ' is-bought' : '') }, photo,
      h('div', { class: 'body' },
        h('h3', {}, i.title), meta,
        i.notes && h('div', { class: 'notes' }, i.notes),
        i.url && h('a', { class: 'shop', href: i.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, `Open link · ${host(i.url)} ↗`),
        actions));
  }

  // ---------- my list ----------
  async function viewMyList() {
    const { items } = await api('GET', '/items');
    paint(
      h('div', { class: 'row between' },
        h('div', {}, h('h1', {}, 'My wish list'), h('p', { class: 'muted', style: 'margin:0' }, 'Everyone in your groups can see this. You\'ll never see what\'s been bought.')),
        h('div', { class: 'row' }, h('button', { class: 'ghost', onclick: importModal }, 'Import'), h('button', { onclick: () => itemModal(null) }, '+ Add something'))),
      h('div', { class: 'section' }, items.length
        ? h('div', { class: 'items' }, items.map((i) => itemCard(i, { mine: true })))
        : h('div', { class: 'empty' }, h('div', { class: 'emoji' }, '✨'),
            h('p', {}, 'Add what you\'d love to get. Type an idea, paste a link from any store, or add a photo.'),
            h('div', { class: 'row', style: 'justify-content:center' }, h('button', { onclick: () => itemModal(null) }, '+ Add something'), h('button', { class: 'ghost', onclick: importModal }, 'Import a list')))));
  }

  // Item editor: typed idea, link, photo (pick / drop / paste), price, priority, notes.
  function itemModal(existing) {
    const i = existing || {};
    let imageKey = i.imageKey || '';
    const title = h('input', { value: i.title || '', placeholder: 'What would you like?', maxlength: 140 });
    const url = h('input', { type: 'url', value: i.url || '', placeholder: 'https://… (optional)', inputmode: 'url' });
    const price = h('input', { value: i.price || '', placeholder: '$25 (optional)', maxlength: 24 });
    const qty = h('input', { type: 'number', min: 1, max: 20, value: i.qty || 1 });
    const priority = h('select', {}, h('option', { value: 0 }, 'Would be nice'), h('option', { value: 1 }, 'Really want'), h('option', { value: 2 }, '★ Most wanted'));
    priority.value = String(i.priority || 0);
    const notes = h('textarea', { placeholder: 'Size, color, model, "any flavor", where to find it…', maxlength: 600 }, i.notes || '');
    const pic = photoPicker(i.imageUrl, (key) => { imageKey = key; });
    // A pasted link in the title box moves to the link box.
    title.addEventListener('paste', (e) => {
      const t = (e.clipboardData || {}).getData && e.clipboardData.getData('text');
      if (t && /^https?:\/\/\S+$/.test(t.trim()) && !url.value) { e.preventDefault(); url.value = t.trim(); if (!title.value) title.placeholder = 'Name it (or leave blank to use the link)'; }
    });
    const body = h('div', {},
      h('div', { class: 'field' }, h('label', {}, 'Item'), title),
      h('div', { class: 'field' }, h('label', {}, 'Link'), url),
      h('div', { class: 'field' }, h('label', {}, 'Photo'), pic.el),
      h('div', { class: 'fields-2 field' }, h('div', {}, h('label', {}, 'Price'), price), h('div', {}, h('label', {}, 'How much you want it'), priority)),
      h('div', { class: 'fields-2 field' }, h('div', {}, h('label', {}, 'How many'), qty), h('div')),
      h('div', { class: 'field' }, h('label', {}, 'Notes'), notes));
    const close = modal(existing ? 'Edit item' : 'Add to your list', body, (closeIt) => [h('button', { onclick: async (e) => {
      if (pic.busy()) return toast('Hang on — the photo is still uploading');
      const data = { title: title.value, url: url.value.trim(), price: price.value, priority: Number(priority.value), qty: Math.max(1, Math.min(20, parseInt(qty.value, 10) || 1)), notes: notes.value, imageKey };
      if (data.url && !/^https?:\/\//i.test(data.url)) data.url = 'https://' + data.url;
      e.target.disabled = true;
      const ok = await act(() => existing ? api('PUT', '/items/' + i.id, data) : api('POST', '/items', data), existing ? 'Saved' : 'Added to your list');
      e.target.disabled = false;
      if (ok) { closeIt(); currentRender(true); }
    } }, existing ? 'Save' : 'Add')]);
    // Paste an image anywhere in the dialog.
    document.querySelector('.modal-back:last-child').addEventListener('paste', (e) => {
      const f = [...(e.clipboardData || {}).items || []].find((x) => x.type.startsWith('image/'));
      if (f) { e.preventDefault(); pic.take(f.getAsFile()); }
    });
    return close;
  }

  function photoPicker(currentUrl, onKey) {
    let busy = false;
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
    const preview = h('div');
    const hint = h('div', { class: 'small' }, 'Tap to choose, drop, or paste a photo or screenshot');
    const remove = h('button', { class: 'danger-text', hidden: !currentUrl, onclick: (e) => { e.stopPropagation(); onKey(''); show(null); } }, 'Remove photo');
    const zone = h('div', { class: 'dropzone', tabindex: 0, onclick: () => file.click() }, preview, hint, remove);
    const show = (src) => { preview.replaceChildren(src ? h('img', { src, alt: '' }) : ''); remove.hidden = !src; };
    show(currentUrl);
    file.onchange = () => file.files[0] && take(file.files[0]);
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) take(f); });
    async function take(f) {
      if (!f) return;
      busy = true; hint.textContent = 'Uploading…';
      try {
        const blob = await shrink(f);
        show(URL.createObjectURL(blob));
        const up = await api('POST', '/uploads', { contentType: 'image/jpeg' });
        const res = await fetch(up.uploadUrl.startsWith('/') ? CFG.api + up.uploadUrl : up.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
        if (!res.ok) throw new Error('Photo upload failed');
        onKey(up.key);
        hint.textContent = 'Photo added — tap to change';
      } catch (e) { toast(e.message, true); hint.textContent = 'Tap to choose, drop, or paste a photo'; show(currentUrl); }
      busy = false;
    }
    return { el: h('div', {}, zone, file), take, busy: () => busy };
  }
  // Photos are resized in the browser (max 1200px JPEG) so uploads stay small.
  async function shrink(f) {
    const img = await createImageBitmap(f);
    const s = Math.min(1, 1200 / Math.max(img.width, img.height));
    const c = h('canvas', { width: Math.round(img.width * s), height: Math.round(img.height * s) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not read that image'))), 'image/jpeg', 0.85));
  }

  // ---------- import ----------
  function guessTitle(u) {
    try {
      const x = new URL(u);
      const parts = x.pathname.split('/').filter((p) => p && !/^(dp|gp|product|p|ip|itm|item|products|s)$/i.test(p) && !/^[A-Z0-9]{10}$/.test(p) && !/^\d+$/.test(p));
      const best = parts.sort((a, b) => b.length - a.length)[0];
      if (best && best.length > 3) return decodeURIComponent(best).replace(/\.\w{2,5}$/, '').replace(/[-_+]+/g, ' ').trim();
      return x.hostname.replace(/^www\./, '');
    } catch (e) { return ''; }
  }
  function parseCsv(textIn) {
    const rows = []; let row = [], cell = '', q = false;
    for (let k = 0; k < textIn.length; k++) {
      const c = textIn[k];
      if (q) { if (c === '"' && textIn[k + 1] === '"') { cell += '"'; k++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && textIn[k + 1] === '\n') k++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
  }
  // Each line: "Title - https://link", "https://link", or just an idea.
  function parsePasted(t) {
    return t.split(/\r?\n/).map((l) => l.trim().replace(/^[-*•\d.)\s]+(?=\S)/, '')).filter(Boolean).map((l) => {
      const m = l.match(/https?:\/\/\S+/);
      if (!m) return { title: l.slice(0, 140), url: '' };
      const url = m[0].replace(/[),.]+$/, '');
      const rest = (l.slice(0, m.index) + ' ' + l.slice(m.index + m[0].length)).replace(/[\s\-–—|:]+$/, '').replace(/^[\s\-–—|:]+/, '').trim();
      return { title: (rest || guessTitle(url)).slice(0, 140), url };
    });
  }
  function rowsFromCsv(t) {
    const rows = parseCsv(t);
    if (!rows.length) return [];
    const head = rows[0].map((x) => x.trim().toLowerCase());
    const col = (names) => head.findIndex((x) => names.includes(x));
    let ti = col(['title', 'name', 'item', 'gift', 'what']), ui = col(['url', 'link', 'website']), pi = col(['price', 'cost']), ni = col(['notes', 'note', 'details', 'comments', 'description']);
    const hasHead = ti >= 0 || ui >= 0;
    if (!hasHead) { ti = 0; ui = 1; pi = 2; ni = 3; }
    return rows.slice(hasHead ? 1 : 0).map((r) => {
      const url = ui >= 0 ? (r[ui] || '').trim() : '';
      return { title: ((ti >= 0 ? r[ti] : '') || '').trim() || guessTitle(url), url, price: pi >= 0 ? (r[pi] || '').trim() : '', notes: ni >= 0 ? (r[ni] || '').trim() : '' };
    }).filter((x) => x.title || x.url);
  }

  function importModal() {
    let rows = [];
    const ta = h('textarea', { style: 'min-height:150px', placeholder: 'One per line, for example:\nCozy wool socks, size L\nKindle Paperwhite - https://www.amazon.com/…\nhttps://www.etsy.com/listing/…' });
    const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain' });
    const preview = h('div');
    const count = h('span', { class: 'muted small' });
    const draw = () => {
      count.textContent = rows.length ? `${rows.filter((r) => r.on).length} of ${rows.length} selected` : '';
      preview.replaceChildren(rows.length ? h('div', { class: 'preview' }, rows.map((r) => {
        const cb = h('input', { type: 'checkbox', checked: r.on, onchange: () => { r.on = cb.checked; draw(); } });
        const ti = h('input', { type: 'text', value: r.title, oninput: () => { r.title = ti.value; } });
        return h('div', { class: 'prow' }, cb, h('div', {}, ti, r.url && h('div', { class: 'url' }, r.url), (r.price || r.notes) && h('div', { class: 'url' }, [r.price, r.notes].filter(Boolean).join(' · '))));
      })) : '');
    };
    const read = () => { rows = parsePasted(ta.value).map((r) => ({ ...r, on: true })); draw(); };
    ta.addEventListener('input', read);
    file.onchange = async () => {
      const f = file.files[0]; if (!f) return;
      const t = await f.text();
      rows = (/\.csv$/i.test(f.name) || t.includes(',') ? rowsFromCsv(t) : parsePasted(t)).slice(0, 100).map((r) => ({ ...r, on: true }));
      draw();
    };
    const body = h('div', {},
      h('p', { class: 'muted small' }, 'Paste a list from your notes, an email, or another wish list site — links are picked up automatically. Or upload a CSV with title, link, price and notes columns.'),
      h('div', { class: 'field' }, ta),
      h('div', { class: 'field' }, h('label', {}, 'Or upload a file'), file),
      h('div', { class: 'field' }, count, preview));
    modal('Import a list', body, (close) => [h('button', { onclick: async (e) => {
      const chosen = rows.filter((r) => r.on && (r.title.trim() || r.url)).map(({ title, url, price, notes }) => ({ title, url, price, notes }));
      if (!chosen.length) return toast('Nothing to import yet', true);
      e.target.disabled = true;
      const ok = await act(() => api('POST', '/items', { items: chosen }), `Imported ${chosen.length} item${chosen.length === 1 ? '' : 's'}`);
      e.target.disabled = false;
      if (ok) { close(); currentRender(true); }
    } }, 'Import')]);
  }

  // ---------- shopping ----------
  async function viewShopping() {
    const { items } = await api('GET', '/shopping');
    const by = {};
    for (const i of items) (by[i.ownerName] = by[i.ownerName] || []).push(i);
    paint(
      h('h1', {}, 'Shopping'),
      h('p', { class: 'muted' }, 'Everything you\'ve marked as bought, by person.'),
      items.length ? null : h('div', { class: 'empty' }, h('div', { class: 'emoji' }, '🛍️'), h('p', {}, 'Nothing yet. When you buy something from someone\'s list, tap "I bought this" and it shows up here.')),
      Object.entries(by).map(([name, list]) => h('div', { class: 'section card' },
        h('h2', {}, `For ${name}`),
        list.map((i) => h('div', { class: 'ex-row' },
          h('div', {}, h('div', { style: 'font-weight:600' }, i.title, i.removed ? h('span', { class: 'pill berry', style: 'margin-left:6px' }, 'Removed from their list') : null),
            h('div', { class: 'muted small' }, [i.price, i.url && host(i.url)].filter(Boolean).join(' · '))),
          h('div', { class: 'row' },
            i.url && h('a', { class: 'small', href: i.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, 'Link ↗'),
            !i.removed && h('a', { class: 'small', href: `#/g/${i.gid}/u/${encodeURIComponent(i.ownerId)}` }, 'Their list')))))));
  }

  // ---------- account ----------
  async function viewMe() {
    if (!me) me = await api('GET', '/me');
    const name = h('input', { value: me.name, maxlength: 40 });
    paint(
      h('h1', {}, 'Your account'),
      h('div', { class: 'card stack' },
        h('div', { class: 'field' }, h('label', {}, 'Your name (what your groups see)'), name),
        h('p', { class: 'muted small' }, 'Signed in as ' + (me.email || 'you')),
        h('div', { class: 'row' }, h('button', { onclick: () => act(async () => { const r = await api('PUT', '/me', { name: name.value }); me.name = r.name; setInitial(); }, 'Saved') }, 'Save'))),
      h('div', { class: 'section' }, h('button', { class: 'ghost', onclick: () => Auth.signOut() }, 'Sign out')));
  }
  function setInitial() { document.getElementById('me-initial').textContent = initials(me && me.name); }

  // ---------- start ----------
  async function start() {
    await Auth.ready;
    if (!Auth.user()) {
      if (/^#\/join\//.test(location.hash)) sessionStorage.setItem('gg.next', location.hash);
      return landing();
    }
    const next = sessionStorage.getItem('gg.next');
    if (next) { sessionStorage.removeItem('gg.next'); history.replaceState(null, '', '/' + next); }
    document.getElementById('top').hidden = false;
    try { me = await api('GET', '/me'); setInitial(); } catch (e) { /* the view will show the error */ }
    window.addEventListener('hashchange', go);
    go();
    connectLive();
  }
  start();
})();
