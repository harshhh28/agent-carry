import fs from 'node:fs';
import path from 'node:path';
import { projectFolders } from './store.js';
import { parseJsonl, summarize } from './transcript.js';
import { desktopSessionInfo, firstPrompt } from './desktop.js';

// The desktop app runs a conversation that has no project folder in a scratch folder with a long account/org path.
const SCRATCH = /\/scratch-workspaces\/[0-9a-f-]{36}\/[0-9a-f-]{36}(?:\/(.*))?$/;
const tilde = (p, home) => {
  const scratch = p && SCRATCH.exec(p);
  if (scratch) return `(desktop scratch folder${scratch[1] ? `: ${scratch[1]}` : ''})`;
  return p && home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p;
};

// Programmatic agents (for example a memory plugin's background observer) record this entrypoint. They are
// not conversations a person had, and on a machine with such a plugin they can outnumber real sessions 50 to 1.
/**
 * Where a session was started, from the entrypoint Claude records on every line: `claude-desktop` is the desktop
 * app, `cli` the terminal, `sdk-cli` a `claude -p` run. A session the desktop app lists in its index counts as
 * desktop even if it began elsewhere (for example one imported with --desktop).
 */
export function sourceOf(sum, inDesktopIndex) {
  const e = sum.entrypoints;
  if (inDesktopIndex || e.includes('claude-desktop')) return 'desktop';
  if (e.includes('cli')) return 'terminal';
  if (e.some((x) => x.startsWith('sdk'))) return 'print mode';
  return e[0] ?? 'unknown';
}

const isBackgroundAgent = (sum) => sum.entrypoints.length > 0 && sum.entrypoints.every((e) => e === 'sdk-ts');

/**
 * The most recent sessions across every project folder, so nobody needs to know where Claude keeps them.
 * Skips sessions with no prompts and background-agent sessions (unless `everything`). Each gets the title the
 * desktop app shows for it when there is one, else Claude's own title, else the first prompt.
 * `source` ('desktop' or 'terminal') keeps only sessions started there. `folders` restricts the search to those project folders; `match` keeps rows whose title, folder or id contains the text.
 */
export function recentSessions({ home, userHome, limit = 20, everything = false, folders, match, source }) {
  const files = [];
  for (const folder of folders ?? projectFolders(home)) {
    if (!fs.existsSync(folder)) continue;
    for (const n of fs.readdirSync(folder)) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(folder, n);
      files.push({ file, folder, id: n.slice(0, -'.jsonl'.length), mtimeMs: fs.statSync(file).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const desk = desktopSessionInfo({ home: userHome });
  const needle = match ? String(match).toLowerCase() : null;
  const out = [];
  for (const x of files) {
    if (out.length >= limit) break;
    const entries = parseJsonl(fs.readFileSync(x.file, 'utf8'));
    const sum = summarize(entries);
    if (sum.turns === 0 || (!everything && isBackgroundAgent(sum))) continue;
    const d = desk.get(x.id);
    const row = { ...x, ...sum, source: sourceOf(sum, !!d), archived: !!d?.archived, label: d?.title || sum.title || firstPrompt(entries) || '(untitled)', where: tilde(sum.dominantCwd ?? x.folder, userHome) };
    if (source && row.source !== source) continue;
    if (needle && !`${row.label} ${row.where} ${row.id}`.toLowerCase().includes(needle)) continue;
    out.push(row);
  }
  return out;
}

export const formatSession = (s, n) => {
  const when = new Date(s.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
  return `${n === undefined ? '' : `${String(n).padStart(2)}. `}${s.id.slice(0, 8)}  ${when}  ${String(s.turns).padStart(3)} turns  ${s.label}  [${s.source}${s.archived ? ', archived' : ''}]  ${s.where}`;
};
