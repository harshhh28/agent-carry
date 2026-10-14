import crypto from 'node:crypto';

/**
 * Transcripts are internal and undocumented, so parsing is tolerant: a line
 * that is not JSON is kept verbatim and travels with the session untouched.
 */
export function parseJsonl(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    try {
      out.push({ raw, rec: JSON.parse(raw) });
    } catch {
      out.push({ raw, rec: null });
    }
  }
  return out;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const sha256 = sha;

/**
 * Identity of a record for merging. Conversation records carry a `uuid`, which
 * is stable across machines. Bookkeeping records (titles, modes, snapshots)
 * have none, so they are identified by content.
 */
export function recordKey({ raw, rec }) {
  if (rec && typeof rec.uuid === 'string') return `u:${rec.uuid}`;
  return `h:${sha(rec ? JSON.stringify(rec) : raw)}`;
}

export function summarize(entries) {
  const cwds = new Map();
  const versions = new Set();
  const entrypoints = new Set();
  let title = null;
  let customTitle = null;
  let first = null;
  let last = null;
  let turns = 0;
  for (const { rec } of entries) {
    if (!rec) continue;
    if (rec.cwd) cwds.set(rec.cwd, (cwds.get(rec.cwd) || 0) + 1);
    if (rec.version) versions.add(rec.version);
    if (rec.entrypoint) entrypoints.add(rec.entrypoint);
    if (rec.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle;
    if (rec.type === 'custom-title' && rec.customTitle) customTitle = rec.customTitle;
    if (rec.timestamp) {
      first ??= rec.timestamp;
      last = rec.timestamp;
    }
    if (rec.type === 'user' && !rec.isMeta && !rec.isSidechain) turns++;
  }
  const dominantCwd = [...cwds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    title: customTitle || title,
    dominantCwd,
    cwds: [...cwds.keys()],
    versions: [...versions],
    entrypoints: [...entrypoints],
    first,
    last,
    turns,
  };
}
