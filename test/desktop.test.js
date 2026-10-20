import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, fakeMachine } from './helpers.js';
import { buildBundle, writeBundle } from '../src/bundle.js';
import { registerDesktopSession, resolveDesktopDir, listDesktopDirs } from '../src/desktop.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

const TEMPLATE = {
  sessionId: 'local_template',
  cliSessionId: 'cccccccc-0000-0000-0000-000000000000',
  cwd: '/somewhere',
  originCwd: '/somewhere',
  createdAt: 1,
  lastActivityAt: 5,
  model: 'claude-test-1',
  effort: 'high',
  isArchived: false,
  title: 'old',
  permissionMode: 'auto',
  enabledMcpTools: { 'srv:tool': true },
  remoteMcpServersConfig: [{ name: 'x' }],
  promptAppendSnapshot: { append: 'app prompt', cliVersion: '9', settingsKey: 'k' },
  alwaysAllowedReasons: ['should not be copied'],
  postTurnSummary: { status_category: 'should not be copied' },
};

function setup({ withTemplate = true } = {}) {
  const a = tmp('carry-a-');
  const b = tmp('carry-b-');
  const rootA = path.join(a, 'work', 'app');
  const rootB = path.join(b, 'code', 'app');
  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  const m = fakeMachine({ userHome: a, projectRoot: fs.realpathSync(rootA) });
  const dd = path.join(b, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(dd, { recursive: true });
  if (withTemplate) fs.writeFileSync(path.join(dd, 'local_template.json'), JSON.stringify(TEMPLATE));
  const { text } = buildBundle({ folder: m.folder, id: m.id, where: { store: m.folder, root: fs.realpathSync(rootA), home: a } });
  const bundle = path.join(a, 'x.carry.gz');
  writeBundle(bundle, text);
  return { rootA: fs.realpathSync(rootA), a, b, rootB: fs.realpathSync(rootB), dd, m, bundle, bClaude: path.join(b, '.claude') };
}

const run = (s, extra = []) =>
  execFileSync('node', [CLI, 'import', s.bundle, '--project-root', s.rootB, '--claude-home', s.bClaude, '--home', s.b, ...extra], { encoding: 'utf8' });
const entries = (dd) => fs.readdirSync(dd).filter((f) => /^local_.*\.json$/.test(f) && f !== 'local_template.json');

test('--desktop adds an index entry pointing at the imported transcript, copying app settings only', () => {
  const s = setup();
  const out = run(s, ['--desktop', '--desktop-dir', s.dd]);
  assert.match(out, /added to the desktop Code tab/);
  const [f] = entries(s.dd);
  const e = JSON.parse(fs.readFileSync(path.join(s.dd, f), 'utf8'));
  assert.equal(e.cliSessionId, s.m.id);
  assert.equal(e.cwd, s.rootB);
  assert.equal(e.originCwd, s.rootB);
  assert.equal(e.title, 'Fix the app');
  assert.equal(e.completedTurns, 2);
  assert.equal(e.isArchived, false);
  assert.equal(e.createdAt, Date.parse('2026-10-14T08:00:00Z'));
  assert.equal(e.permissionMode, 'auto');
  assert.deepEqual(e.promptAppendSnapshot, TEMPLATE.promptAppendSnapshot);
  assert.deepEqual(e.alwaysAllowedReasons, []);
  assert.equal(e.postTurnSummary, undefined);
  assert.notEqual(e.sessionId, TEMPLATE.sessionId);
  assert.equal(fs.statSync(path.join(s.dd, f)).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(s.bClaude, 'projects')), 'transcript itself was imported');
});

test('registering twice is a no-op', () => {
  const s = setup();
  run(s, ['--desktop-dir', s.dd]);
  const out = run(s, ['--desktop-dir', s.dd]);
  assert.match(out, /already in the desktop Code tab/);
  assert.equal(entries(s.dd).length, 1);
});

test('--dry-run writes no index entry', () => {
  const s = setup();
  const out = run(s, ['--desktop-dir', s.dd, '--dry-run']);
  assert.match(out, /would be added/);
  assert.equal(entries(s.dd).length, 0);
});

test('without --desktop nothing is written to the desktop folder', () => {
  const s = setup();
  run(s);
  assert.equal(entries(s.dd).length, 0);
});

test('no template session: the transcript still imports and the desktop step explains itself', () => {
  const s = setup({ withTemplate: false });
  const r = execFileSync('node', [CLI, 'import', s.bundle, '--project-root', s.rootB, '--claude-home', s.bClaude, '--home', s.b, '--desktop-dir', s.dd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(r, /imported/);
  assert.equal(entries(s.dd).length, 0);
});

test('desktop folder lookup: the signed-in account from the app log wins; several folders and no signal refuses', () => {
  const home = tmp('carry-h-');
  const root = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  assert.throws(() => resolveDesktopDir({ home: tmp(), platform: 'darwin' }), /open the Code tab once/);
  const a1 = '11111111-1111-1111-1111-111111111111';
  const a2 = '22222222-2222-2222-2222-222222222222';
  const o = '0a0a0a0a-0000-0000-0000-000000000000';
  fs.mkdirSync(path.join(root, a1, o), { recursive: true });
  assert.equal(resolveDesktopDir({ home, platform: 'darwin' }).dir, path.join(root, a1, o), 'a single folder needs no signal');
  fs.mkdirSync(path.join(root, a2, o), { recursive: true });
  fs.writeFileSync(path.join(root, a1, o, 'local_x.json'), '{}');
  assert.throws(() => resolveDesktopDir({ home, platform: 'darwin' }), /cannot tell which desktop account is signed in/, 'old sessions alone are not a signal');
  const logs = path.join(home, 'Library', 'Logs', 'Claude');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(logs + '/main.log', `x scratch-workspaces/${a1}/${o}/s1\ny scratch-workspaces/${a2}/${o}/s2\n`);
  const r = resolveDesktopDir({ home, platform: 'darwin' });
  assert.equal(r.dir, path.join(root, a2, o), 'the account named last in the log is the signed-in one');
  assert.match(r.how, /signed-in/);
  assert.deepEqual(listDesktopDirs({ home, platform: 'darwin' }).map((x) => [x.entries, x.active]).sort(), [[0, true], [1, false]]);
  assert.throws(() => resolveDesktopDir({ home, platform: 'linux' }), /only implemented for macOS/);
});

test('a freshly signed-in account borrows app settings from another account, but not its connectors or permissions', () => {
  const s = setup({ withTemplate: false });
  const other = path.join(path.dirname(path.dirname(s.dd)), 'other-acct', 'org');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'local_template.json'), JSON.stringify(TEMPLATE));
  const out = run(s, ['--desktop-dir', s.dd]);
  assert.match(out, /settings were borrowed/);
  const [f] = entries(s.dd);
  const e = JSON.parse(fs.readFileSync(path.join(s.dd, f), 'utf8'));
  assert.equal(e.cliSessionId, s.m.id);
  assert.deepEqual(e.enabledMcpTools, {});
  assert.deepEqual(e.remoteMcpServersConfig, []);
  assert.equal(e.permissionMode, 'default');
  assert.deepEqual(e.promptAppendSnapshot, TEMPLATE.promptAppendSnapshot);
});

test('export --latest skips a newer empty session', () => {
  const s = setup();
  const empty = path.join(s.m.folder, 'eeeeeeee-0000-0000-0000-000000000000.jsonl');
  fs.writeFileSync(empty, JSON.stringify({ type: 'mode', mode: 'default' }) + '\n');
  const out = path.join(s.b, 'latest.carry.gz');
  const r = execFileSync('node', [CLI, 'export', '--latest', '--project-root', s.rootA, '--claude-home', s.m.claude, '-o', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(r, new RegExp(s.m.id.slice(0, 8)));
});

test('an unreadable entry in the folder does not break registration', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.dd, 'local_broken.json'), '{not json');
  const main = path.join(s.bClaude, 'projects');
  run(s);
  const mainFile = fs.readdirSync(main).map((d) => path.join(main, d, `${s.m.id}.jsonl`)).find((f) => fs.existsSync(f));
  const r = registerDesktopSession({ id: s.m.id, root: s.rootB, mainFile, home: s.b, dir: s.dd });
  assert.equal(r.status, 'registered');
});

test('--desktop strips terminal colour codes from newly imported text; a plain import keeps them', () => {
  const s = setup();
  const esc = String.fromCharCode(27);
  const line = JSON.stringify({ type: 'user', uuid: 'c1', parentUuid: 'u2', sessionId: s.m.id, timestamp: '2026-10-14T08:01:00Z', message: { role: 'user', content: `<local-command-stdout>${esc}[1mContext${esc}[22m ${esc}[38;2;1;2;3mused${esc}[39m</local-command-stdout>` } });
  fs.appendFileSync(s.m.main, line + '\n');
  const bundle = path.join(s.b, 'c.carry.gz');
  const { text } = buildBundle({ folder: s.m.folder, id: s.m.id, where: { store: s.m.folder, root: s.rootA, home: s.a } });
  writeBundle(bundle, text);
  const imp = (flag, root) => {
    fs.mkdirSync(root, { recursive: true });
    execFileSync('node', [CLI, 'import', bundle, '--project-root', root, '--claude-home', s.bClaude, '--home', s.b, ...flag], { encoding: 'utf8' });
    const dir = path.join(s.bClaude, 'projects');
    return fs.readdirSync(dir).map((d) => path.join(dir, d, `${s.m.id}.jsonl`)).filter(fs.existsSync).map((f) => fs.readFileSync(f, 'utf8'));
  };
  const keep = imp([], path.join(s.b, 'plain'))[0];
  assert.ok(keep.includes('\\u001b['), 'plain import keeps colour codes');
  const stripped = imp(['--desktop-dir', s.dd], path.join(s.b, 'dt')).find((t) => t !== keep);
  assert.ok(!stripped.includes('\\u001b['));
  assert.ok(stripped.includes('Context used'));
});
