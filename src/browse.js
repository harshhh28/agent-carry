import fs from 'node:fs';
import path from 'node:path';
import { projectFolders } from './store.js';
import { parseJsonl, summarize } from './transcript.js';
import { desktopSessionTitles, firstPrompt } from './desktop.js';

const tilde = (p, home) => (p && home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p);

// Programmatic agents (for example a memory plugin's background observer) record this entrypoint. They are
// not conversations a person had, and on a machine with such a plugin they can outnumber real sessions 50 to 1.
const isBackgroundAgent = (sum) => sum.entrypoints.length > 0 && sum.entrypoints.every((e) => e === 'sdk-ts');

/**
 * The most recent sessions across every project folder, so nobody needs to know where Claude keeps them.
 * Skips sessions with no prompts and background-agent sessions (unless `everything`). Each gets the title the
 * desktop app shows for it when there is one, else Claude's own title, else the first prompt.
 */
export function recentSessions({ home, userHome, limit = 20, everything = false }) {
  const files = [];
  for (const folder of projectFolders(home)) {
    for (const n of fs.readdirSync(folder)) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(folder, n);
      files.push({ file, folder, id: n.slice(0, -'.jsonl'.length), mtimeMs: fs.statSync(file).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const titles = desktopSessionTitles({ home: userHome });
  const out = [];
  for (const x of files) {
    if (out.length >= limit) break;
    const entries = parseJsonl(fs.readFileSync(x.file, 'utf8'));
    const sum = summarize(entries);
    if (sum.turns === 0 || (!everything && isBackgroundAgent(sum))) continue;
    out.push({ ...x, ...sum, desktop: titles.has(x.id), label: titles.get(x.id) || sum.title || firstPrompt(entries) || '(untitled)', where: tilde(sum.dominantCwd ?? x.folder, userHome) });
  }
  return out;
}

export const formatSession = (s, n) => {
  const when = new Date(s.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
  return `${n === undefined ? '' : `${String(n).padStart(2)}. `}${s.id.slice(0, 8)}  ${when}  ${String(s.turns).padStart(3)} turns  ${s.label}${s.desktop ? '  [desktop app]' : ''}  ${s.where}`;
};
