import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseJsonl, summarize } from './transcript.js';

/**
 * The Claude desktop app's Code tab lists sessions from its own index, one
 * `local_<uuid>.json` per session, whose `cliSessionId` points at the normal
 * Claude Code transcript. Importing a transcript does not add it to that
 * index, so it would resume in a terminal but not show up in the Code tab.
 *
 * This writes the missing index entry. App-level settings (MCP servers,
 * prompt snapshot, ...) are copied from the newest existing entry rather than
 * invented, so a Code tab that has never been used cannot be targeted.
 */

const KEEP_FROM_TEMPLATE = [
  'effort',
  'permissionMode',
  'enabledMcpTools',
  'remoteMcpServersConfig',
  'chromePermissionMode',
  'classifierSummaryEnabled',
  'reportFindingsCard',
  'promptAppendSnapshot',
  'toolSurfaceSnapshot',
];

export function desktopRoot(home, platform = process.platform) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  throw new Error('automatic desktop-app lookup is only implemented for macOS; pass --desktop-dir');
}

const subdirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));

/**
 * The folder holding local_*.json: <root>/<account>/<org>. Account/org folders without any session
 * entry are ignored; if several remain, the one with the newest entry wins (and `others` says so).
 */
export function resolveDesktopDir({ home, dir, platform }) {
  if (dir) {
    if (!fs.existsSync(dir)) throw new Error(`desktop folder not found: ${dir}`);
    return { dir: path.resolve(dir), others: [] };
  }
  const root = desktopRoot(home, platform);
  if (!fs.existsSync(root)) throw new Error(`no Claude desktop Code-tab data at ${root}; open the Code tab once first`);
  const leaves = subdirs(root).flatMap(subdirs);
  if (leaves.length === 0) throw new Error(`no account folder under ${root}; open the Code tab once first`);
  const used = leaves
    .map((d) => ({ d, newest: Math.max(0, ...fs.readdirSync(d).filter((f) => /^local_.*\.json$/.test(f)).map((f) => fs.statSync(path.join(d, f)).mtimeMs)) }))
    .filter((x) => x.newest > 0)
    .sort((a, b) => b.newest - a.newest);
  if (used.length === 0) throw new Error(`no Code-tab session found under ${root}; start one session in the desktop app Code tab first`);
  return { dir: used[0].d, others: used.slice(1).map((x) => x.d) };
}

function readEntries(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^local_.*\.json$/.test(f)) continue;
    try {
      out.push({ file: f, json: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) });
    } catch {
      // an unreadable entry is not ours to judge; skip it
    }
  }
  return out;
}

function lastModel(entries) {
  let model = null;
  for (const { rec } of entries) if (rec?.type === 'assistant' && typeof rec.message?.model === 'string') model = rec.message.model;
  return model;
}

function firstPrompt(entries) {
  for (const { rec } of entries) {
    if (rec?.type !== 'user' || rec.isMeta || rec.isSidechain) continue;
    const c = rec.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p) => p?.type === 'text')?.text : null;
    if (text && !text.startsWith('<')) return text.replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  return null;
}

/** Build the index entry for an already-imported session. Pure; no I/O. */
export function buildDesktopEntry({ template, cliSessionId, root, transcript, now = Date.now(), uuid = crypto.randomUUID() }) {
  const s = summarize(transcript);
  const at = (iso, fallback) => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : fallback);
  const entry = {
    sessionId: `local_${uuid}`,
    cliSessionId,
    cwd: root,
    originCwd: root,
    createdAt: at(s.first, now),
    lastActivityAt: at(s.last, now),
    lastFocusedAt: at(s.last, now),
    model: lastModel(transcript) || template.model,
    isArchived: false,
    title: s.title || firstPrompt(transcript) || `Imported session ${cliSessionId.slice(0, 8)}`,
    titleSource: 'auto',
    completedTurns: s.turns,
    lastSpawnRootDetected: false,
    alwaysAllowedReasons: [],
    sessionPermissionUpdates: [],
    spawnSeed: {},
  };
  for (const k of KEEP_FROM_TEMPLATE) if (template[k] !== undefined) entry[k] = template[k];
  return entry;
}

/**
 * Register an imported session with the desktop app. Idempotent: a session
 * that already has an index entry is left alone.
 * Returns { status: 'registered' | 'exists' | 'would-register', file, dir }.
 */
export function registerDesktopSession({ id, root, mainFile, home, dir, platform, dryRun = false }) {
  const { dir: target, others } = resolveDesktopDir({ home, dir, platform });
  const existing = readEntries(target);
  const have = existing.find(({ json }) => json.cliSessionId === id || (Array.isArray(json.priorCliSessionIds) && json.priorCliSessionIds.includes(id)));
  if (have) return { status: 'exists', file: have.file, dir: target, others };
  const template = existing.filter(({ json }) => !json.isArchived).sort((a, b) => (b.json.lastActivityAt || 0) - (a.json.lastActivityAt || 0))[0]?.json;
  if (!template) throw new Error('no existing Code-tab session to copy app settings from; start one session in the desktop app Code tab first');

  if (dryRun) return { status: 'would-register', file: 'a new local_*.json', dir: target, others };
  const entry = buildDesktopEntry({ template, cliSessionId: id, root, transcript: parseJsonl(fs.readFileSync(mainFile, 'utf8')) });
  const file = `${entry.sessionId}.json`;
  const dest = path.join(target, file);
  const tmp = `${dest}.carry-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  return { status: 'registered', file, dir: target, others };
}
