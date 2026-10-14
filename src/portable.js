/**
 * Path portability. Absolute paths are swapped for tokens on export and for the
 * target machine's paths on import. Order matters: the project's session store
 * lives under HOME and contains the project root in mangled form, so the
 * longest, most specific prefix is replaced first.
 */
export const TOKENS = {
  store: '${CARRY_STORE}',
  root: '${CARRY_ROOT}',
  home: '${CARRY_HOME}',
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A path only matches as a whole segment run: `/work/app` must not touch
// `/work/app-two` or `/work/app.bak`, and must not match inside `/x/work/app`.
const prefixRe = (abs) =>
  new RegExp(`(?:(?<![A-Za-z0-9])|(?<=\\\\[nrt])|(?<=(?:\\x1b|u001b)\\[[0-9;]*m))${escapeRe(abs)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'g');

const THINKING = new Set(['thinking', 'redacted_thinking']);

/**
 * Apply `fn` to every string value in a parsed record. Thinking blocks are
 * skipped on purpose: they carry a cryptographic signature and the API rejects
 * a resumed history in which one was edited.
 */
export function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const m = mapStrings(v, fn);
      if (m !== v) changed = true;
      return m;
    });
    return changed ? out : value;
  }
  if (value && typeof value === 'object') {
    if (THINKING.has(value.type)) return value;
    let changed = false;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Keys too: file-history snapshots are maps keyed by absolute path.
      const nk = fn(k);
      const m = mapStrings(v, fn);
      if (m !== v || nk !== k) changed = true;
      out[nk] = m;
    }
    return changed ? out : value;
  }
  return value;
}

/** Build a string rewriter from a list of [from, to] prefix pairs, applied in order of `from` length. */
function rewriter(pairs) {
  const ordered = pairs
    .filter(([from]) => from && from !== '/')
    .sort((a, b) => b[0].length - a[0].length)
    .map(([from, to]) => ({ from, to, re: prefixRe(from) }));
  const stats = { replaced: 0 };
  const fn = (s) => {
    let out = s;
    for (const { from, to, re } of ordered) {
      if (!out.includes(from)) continue;
      out = out.replace(re, () => {
        stats.replaced++;
        return to;
      });
    }
    return out;
  };
  return { fn, stats };
}

/** `where` = {store, root, home}: absolute paths on the machine we are on. */
export function toPortable(where) {
  return rewriter([
    [where.store, TOKENS.store],
    [where.root, TOKENS.root],
    [where.home, TOKENS.home],
  ]);
}

export function fromPortable(where) {
  // Tokens are unambiguous, so a plain global replace is enough.
  const pairs = [
    [TOKENS.store, where.store],
    [TOKENS.root, where.root],
    [TOKENS.home, where.home],
  ];
  const stats = { replaced: 0 };
  const fn = (s) => {
    if (!s.includes('${CARRY_')) return s;
    let out = s;
    for (const [tok, abs] of pairs) {
      if (!out.includes(tok)) continue;
      out = out.split(tok).join(abs);
      stats.replaced++;
    }
    return out;
  };
  return { fn, stats };
}

/** Distinct absolute home-style paths that survived tokenisation (a leak signal, reported to the user). */
export function residualHomePaths(strings) {
  const found = new Set();
  const re = /(?:\/Users|\/home)\/[^/\s"'`\\]+/g;
  for (const s of strings) for (const m of s.matchAll(re)) found.add(m[0]);
  return found;
}
