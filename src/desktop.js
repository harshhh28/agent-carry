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

/** The account the Claude Code CLI is logged in to, with its readable name, from ~/.claude.json. */
export function cliAccount(userHome) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(userHome, '.claude.json'), 'utf8'));
    const a = j.oauthAccount;
    if (!a?.accountUuid) return null;
    return { account: a.accountUuid, org: a.organizationUuid ?? null, name: a.fullName || a.displayName || null, email: a.emailAddress ?? null, orgName: a.organizationName && !(a.emailAddress && a.organizationName.includes(a.emailAddress)) ? a.organizationName : null };
  } catch {
    return null;
  }
}

/** The account the desktop app is signed in to: its own config.json records the last one. */
export function desktopSignedInAccount(home, platform = process.platform) {
  if (platform !== 'darwin') return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'Library', 'Application Support', 'Claude', 'config.json'), 'utf8'));
    return typeof j.lastKnownAccountUuid === 'string' ? j.lastKnownAccountUuid : null;
  } catch {
    return null;
  }
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Every <root>/<account>/<org> folder, with a readable label. The app stores accounts by id only, so a name is
 * known for the account this machine's Claude Code CLI is logged in to; any other account is described by how
 * many sessions it holds and a title or two, which is what a person can recognise.
 * `active`: the account the desktop app is signed in to. `cli`: the account the CLI uses.
 */
export function listDesktopDirs({ home, platform }) {
  const root = desktopRoot(home, platform);
  if (!fs.existsSync(root)) throw new Error(`no Claude desktop Code-tab data at ${root}; open the Code tab once first`);
  const me = cliAccount(home);
  const leaves = subdirs(root).flatMap((a) =>
    subdirs(a).map((d) => {
      const entries = readEntries(d);
      const files = entries.length;
      const newest = Math.max(0, ...fs.readdirSync(d).filter((f) => /^local_.*\.json$/.test(f)).map((f) => fs.statSync(path.join(d, f)).mtimeMs));
      const account = path.basename(a);
      const org = path.basename(d);
      const isMe = !!me && me.account === account;
      const titles = entries.filter(({ json }) => json.title && !json.isArchived).sort((x, y) => (y.json.lastActivityAt || 0) - (x.json.lastActivityAt || 0)).map(({ json }) => String(json.title).slice(0, 40)).filter((t, i, all) => all.indexOf(t) === i).slice(0, 2).map((t) => `“${t}”`);
      const who = isMe ? [me.name, me.email && `<${me.email}>`].filter(Boolean).join(' ') || 'This Claude Code login' : 'A different Claude account';
      const orgName = isMe && me.org === org && me.orgName ? ` · ${me.orgName}` : '';
      const label = `${who}${orgName} (${files === 0 ? 'no sessions in the Code tab yet' : `${plural(files, 'session')} in the Code tab`}${titles.length ? `, e.g. ${titles.join(', ')}` : ''})`;
      return { dir: d, account, org, entries: files, newest, cli: isMe, name: isMe ? me.name : null, email: isMe ? me.email : null, label };
    }),
  );
  // The signed-in desktop account (config.json; the app log as a fallback), and within it the org in use.
  const log = activeAccountFromLog(home, platform);
  const acct = desktopSignedInAccount(home, platform) ?? log?.account ?? null;
  let activeDir = null;
  if (acct) {
    const mine = leaves.filter((x) => x.account === acct);
    const pick = (log && log.account === acct && mine.find((x) => x.org === log.org)) || (me && me.account === acct && mine.find((x) => x.org === me.org)) || [...mine].sort((x, y) => y.newest - x.newest)[0];
    activeDir = pick?.dir ?? null;
  }
  return leaves.map((x) => ({ ...x, active: x.dir === activeDir }));
}

/**
 * Which folder to write to, so nobody has to know account ids:
 *  - --desktop-dir if given;
 *  - in the desktop app, or when only one account could be meant: the account the desktop app is signed in to;
 *  - in a terminal: that same account if the terminal is logged in to it, but if the terminal and the desktop app
 *    are logged in as different accounts, ask (the error lists them by name), because a session written into the
 *    wrong account's Code tab would never be seen.
 * `surface` is CLAUDE_CODE_ENTRYPOINT: 'cli' for a terminal, 'claude-desktop' for the desktop app.
 */
export function resolveDesktopDir({ home, dir, platform, surface = process.env.CLAUDE_CODE_ENTRYPOINT }) {
  if (dir) {
    if (!fs.existsSync(dir)) throw new Error(`desktop folder not found: ${dir}`);
    return { dir: path.resolve(dir), how: 'chosen by you', label: null };
  }
  const all = listDesktopDirs({ home, platform });
  if (all.length === 0) throw new Error('no account folder in the desktop app data; open the Code tab once first');
  const desk = all.find((x) => x.active);
  const mine = all.filter((x) => x.cli);
  const cli = mine.find((x) => x.active) ?? [...mine].sort((x, y) => y.newest - x.newest)[0];
  if (surface === 'cli' && cli && desk && cli.account !== desk.account) {
    const e = new Error(
      `this terminal is logged in as one Claude account but the desktop app is signed in as another; which Code tab should get the session?\n` +
        `  1. ${cli.label}   (--desktop-dir "${cli.dir}")\n  2. ${desk.label}   (--desktop-dir "${desk.dir}")`,
    );
    e.choices = [cli, desk];
    throw e;
  }
  const chosen = desk ?? (surface === 'cli' ? cli : null) ?? (all.length === 1 ? all[0] : null);
  if (chosen) return { dir: chosen.dir, how: chosen === desk ? 'the signed-in desktop account' : 'the only account folder', label: chosen.label };
  const rows = all.map((x, i) => `  ${i + 1}. ${x.label}   (--desktop-dir "${x.dir}")`).join('\n');
  const e = new Error(`cannot tell which desktop account is signed in; choose one:\n${rows}`);
  e.choices = all;
  throw e;
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
  const { dir: target, how, label } = resolveDesktopDir({ home, dir, platform });
  const existing = readEntries(target);
  const have = existing.find(({ json }) => json.cliSessionId === id || (Array.isArray(json.priorCliSessionIds) && json.priorCliSessionIds.includes(id)));
  if (have) return { status: 'exists', file: have.file, dir: target, how, label, entryCwd: have.json.cwd };
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
  if (dryRun) return { status: 'would-register', file: 'a new local_*.json', dir: target, how, label, borrowed };

  const entry = buildDesktopEntry({ template, cliSessionId: id, root, transcript: parseJsonl(fs.readFileSync(mainFile, 'utf8')) });
  const file = `${entry.sessionId}.json`;
  const dest = path.join(target, file);
  const tmp = `${dest}.carry-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  return { status: 'registered', file, dir: target, how, label, borrowed };
}

/** cliSessionId -> { title, archived } as the desktop app lists it. Empty when there is no desktop app data. */
export function desktopSessionInfo({ home, platform }) {
  const out = new Map();
  try {
    for (const { dir } of listDesktopDirs({ home, platform })) {
      for (const { json } of readEntries(dir)) if (json.cliSessionId) out.set(json.cliSessionId, { title: json.title || null, archived: !!json.isArchived });
    }
  } catch {
    // no desktop app, unreadable data, or a platform we don't know: this is a nicety, not a requirement
  }
  return out;
}
