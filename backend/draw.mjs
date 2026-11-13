// Secret-gifter draw: everyone gives exactly one gift and gets exactly one,
// nobody draws themselves, and blocked pairs (same household, exclusions) never match.

// rules.households: { userId: 'label' }   people sharing a label never draw each other
// rules.exclusions: [[a, b], ...]          a and b never draw each other (both ways)
// rules.noPairs: true                      avoid A->B with B->A (when 4+ people)
export function blockedPairs(ids, rules = {}) {
  const blocked = new Set(ids.map((id) => id + '>' + id));
  const hh = rules.households || {};
  for (const a of ids) for (const b of ids) {
    if (a !== b && hh[a] && hh[a] === hh[b]) blocked.add(a + '>' + b);
  }
  for (const [a, b] of rules.exclusions || []) { blocked.add(a + '>' + b); blocked.add(b + '>' + a); }
  return blocked;
}

function shuffle(a, rand) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Returns { giverId: receiverId } or null when the rules make a draw impossible.
export function drawNames(ids, rules = {}, rand = Math.random) {
  if (ids.length < 2) return null;
  const blocked = blockedPairs(ids, rules);
  const noPairs = rules.noPairs && ids.length >= 4;
  const options = Object.fromEntries(ids.map((g) => [g, ids.filter((r) => !blocked.has(g + '>' + r))]));
  if (ids.some((g) => options[g].length === 0)) return null;

  let steps = 0;
  const LIMIT = 200000;
  const tryOnce = () => {
    // Most-constrained givers first, ties broken at random.
    const givers = shuffle([...ids], rand).sort((a, b) => options[a].length - options[b].length);
    const taken = new Set();
    const out = {};
    const place = (i) => {
      if (i === givers.length) return true;
      const g = givers[i];
      for (const r of shuffle([...options[g]], rand)) {
        if (++steps > LIMIT) return false;
        if (taken.has(r) || (noPairs && out[r] === g)) continue;
        taken.add(r); out[g] = r;
        if (place(i + 1)) return true;
        taken.delete(r); delete out[g];
      }
      return false;
    };
    return place(0) ? out : null;
  };
  return tryOnce();
}
