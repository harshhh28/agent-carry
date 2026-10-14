import fs from 'node:fs';
import path from 'node:path';
import { projectsDir } from './paths.js';
import { parseJsonl, summarize } from './transcript.js';

const MAX_SIDECAR_BYTES = 20 * 1024 * 1024;

/** Every project folder under <home>/projects. */
export function projectFolders(home) {
  const dir = projectsDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name));
}

/** Sessions in one project folder, newest first. */
export function listSessions(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const file = path.join(folder, f);
      const st = fs.statSync(file);
      const s = summarize(parseJsonl(fs.readFileSync(file, 'utf8')));
      return { id: f.slice(0, -'.jsonl'.length), file, folder, size: st.size, mtimeMs: st.mtimeMs, ...s };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Resolve a full id or unique prefix, searching `folders` in order. */
export function findSession(folders, idOrPrefix) {
  const hits = [];
  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    for (const f of fs.readdirSync(folder)) {
      if (f.endsWith('.jsonl') && f.startsWith(idOrPrefix)) hits.push({ folder, id: f.slice(0, -6) });
    }
  }
  if (hits.length === 0) throw new Error(`no session matches "${idOrPrefix}"`);
  if (hits.length > 1) {
    const where = hits.map((h) => `${h.id.slice(0, 8)} in ${path.basename(h.folder)}`).join('; ');
    throw new Error(`"${idOrPrefix}" matches more than one session (${where}). Narrow it with --project DIR or a longer id.`);
  }
  return hits[0];
}

/**
 * Everything that belongs to a session: its transcript plus the sidecar
 * directory (`<id>/subagents/*.jsonl`, `<id>/tool-results/*`). Transcripts
 * reference tool-results by absolute path, so they must travel together.
 */
export function readSession(folder, id) {
  const parts = [{ rel: 'main.jsonl', kind: 'jsonl', text: fs.readFileSync(path.join(folder, `${id}.jsonl`), 'utf8') }];
  const skipped = [];
  const sideDir = path.join(folder, id);
  const walk = (dir, relBase) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.posix.join(relBase, e.name);
      if (e.isDirectory()) walk(abs, rel);
      else if (e.isFile()) {
        if (fs.statSync(abs).size > MAX_SIDECAR_BYTES) {
          skipped.push(rel);
          continue;
        }
        const buf = fs.readFileSync(abs);
        if (rel.endsWith('.jsonl')) parts.push({ rel: `side/${rel}`, kind: 'jsonl', text: buf.toString('utf8') });
        else if (isText(buf)) parts.push({ rel: `side/${rel}`, kind: 'text', text: buf.toString('utf8') });
        else parts.push({ rel: `side/${rel}`, kind: 'binary', base64: buf.toString('base64') });
      }
    }
  };
  if (fs.existsSync(sideDir)) walk(sideDir, '');
  return { parts, skipped };
}

function isText(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}
