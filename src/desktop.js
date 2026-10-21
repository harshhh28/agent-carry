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

// Settings that belong to the app, not to an account: safe to borrow from a session of another account.
const GENERIC_KEYS = ['effort', 'classifierSummaryEnabled', 'reportFindingsCard', 'promptAppendSnapshot', 'chromePermissionMode'];

// Everything below also reflects one account's MCP connectors and tool toggles, so it is copied only from the same account.
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
 * The app's most recently active account/org, read from its own log: the app starts every session under
 * scratch-workspaces/<account>/<org>/, so the last such path names whoever is signed in now.
 */
export function activeAccountFromLog(home, platform = process.platform) {
  if (platform !== 'darwin') return null;
  const log = path.join(home, 'Library', 'Logs', 'Claude', 'main.log');
  try {
    const size = fs.statSync(log).size;
    const fd = fs.openSync(log, 'r');
    const len = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const all = [...buf.toString('utf8').matchAll(/scratch-workspaces\/([0-9a-f-]{36})\/([0-9a-f-]{36})/g)];
    const last = all[all.length - 1];
    return last ? { account: last[1], org: last[2] } : null;
  } catch {
    return null;
  }
}

/** Every <root>/<account>/<org> folder, with how many sessions it holds and whether it is the signed-in one. */
export function listDesktopDirs({ home, platform }) {
  const root = desktopRoot(home, platform);
  if (!fs.existsSync(root)) throw new Error(`no Claude desktop Code-tab data at ${root}; open the Code tab once first`);
  const active = activeAccountFromLog(home, platform);
  return subdirs(root).flatMap((a) =>
    subdirs(a).map((d) => {
      const files = fs.readdirSync(d).filter((f) => /^local_.*\.json$/.test(f));
      const newest = Math.max(0, ...files.map((f) => fs.statSync(path.join(d, f)).mtimeMs));
      return { dir: d, account: path.basename(a), org: path.basename(d), entries: files.length, newest, active: !!active && active.account === path.basename(a) && active.org === path.basename(d) };
    }),
  );
}

/**
 * Which folder to write to: --desktop-dir if given, else the signed-in account/org (from the app log), else
 * the only folder if there is just one. With several and no signal it refuses rather than guess, because a
 * session written into another account's folder would never be seen.
 */
export function resolveDesktopDir({ home, dir, platform }) {
  if (dir) {
    if (!fs.existsSync(dir)) throw new Error(`desktop folder not found: ${dir}`);
    return { dir: path.resolve(dir), how: 'given' };
  }
  const all = listDesktopDirs({ home, platform });
  if (all.length === 0) throw new Error('no account folder in the desktop app data; open the Code tab once first');
  const active = all.find((x) => x.active);
  if (active) return { dir: active.dir, how: 'signed-in account (from the app log)' };
  if (all.length === 1) return { dir: all[0].dir, how: 'only account folder' };
  const rows = all.map((x) => `  ${x.dir}  (${x.entries} session${x.entries === 1 ? '' : 's'})`).join('\n');
  throw new Error(`cannot tell which desktop account is signed in; pick one with --desktop-dir:\n${rows}`);
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

export function firstPrompt(entries) {
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
  if (template.generic) {
    // Another account's session: take app settings only. Connectors and permission grants are account-specific,
    // and the safest permission mode is the default one.
    for (const k of GENERIC_KEYS) if (template[k] !== undefined) entry[k] = template[k];
    entry.permissionMode = 'default';
    entry.enabledMcpTools = {};
    entry.remoteMcpServersConfig = [];
  } else {
    for (const k of KEEP_FROM_TEMPLATE) if (template[k] !== undefined) entry[k] = template[k];
  }
  return entry;
}

/**
 * Register an imported session with the desktop app. Idempotent: a session
 * that already has an index entry is left alone.
 * Returns { status: 'registered' | 'exists' | 'would-register', file, dir }.
 */
export function registerDesktopSession({ id, root, mainFile, home, dir, platform, dryRun = false }) {
  const { dir: target, how } = resolveDesktopDir({ home, dir, platform });
  const existing = readEntries(target);
  const have = existing.find(({ json }) => json.cliSessionId === id || (Array.isArray(json.priorCliSessionIds) && json.priorCliSessionIds.includes(id)));
  if (have) return { status: 'exists', file: have.file, dir: target, how, entryCwd: have.json.cwd };
  const newest = (list) => list.filter(({ json }) => !json.isArchived).sort((a, b) => (b.json.lastActivityAt || 0) - (a.json.lastActivityAt || 0))[0]?.json;
  let template = newest(existing);
  let borrowed = false;
  if (!template) {
    // A freshly signed-in account has no sessions yet; borrow app-level settings from any other account's.
    const others = listDesktopDirs({ home, platform }).filter((x) => x.dir !== target).flatMap((x) => readEntries(x.dir));
    const t = newest(others);
    if (t) {
      template = { ...t, generic: true };
      borrowed = true;
    }
  }
  if (!template) throw new Error('no existing Code-tab session anywhere to copy app settings from; start one session in the desktop app Code tab first');
  if (dryRun) return { status: 'would-register', file: 'a new local_*.json', dir: target, how, borrowed };

  const entry = buildDesktopEntry({ template, cliSessionId: id, root, transcript: parseJsonl(fs.readFileSync(mainFile, 'utf8')) });
  const file = `${entry.sessionId}.json`;
  const dest = path.join(target, file);
  const tmp = `${dest}.carry-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  return { status: 'registered', file, dir: target, how, borrowed };
}

/** cliSessionId -> the title the desktop app shows for it. Empty when there is no desktop app data. */
export function desktopSessionTitles({ home, platform }) {
  const out = new Map();
  try {
    for (const { dir } of listDesktopDirs({ home, platform })) {
      for (const { json } of readEntries(dir)) if (json.cliSessionId && json.title) out.set(json.cliSessionId, json.title);
    }
  } catch {
    // no desktop app, unreadable data, or a platform we don't know: titles are a nicety
  }
  return out;
}
