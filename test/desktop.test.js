import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, fakeMachine } from './helpers.js';
import { buildBundle, writeBundle } from '../src/bundle.js';
import { registerDesktopSession, resolveDesktopDir } from '../src/desktop.js';

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
  const dd = path.join(b, 'desktop', 'acct', 'org');
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

test('desktop folder lookup ignores empty accounts and picks the most recently used one', () => {
  const home = tmp('carry-h-');
  const root = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  assert.throws(() => resolveDesktopDir({ home: tmp(), platform: 'darwin' }), /open the Code tab once/);
  fs.mkdirSync(path.join(root, 'a1', 'o1'), { recursive: true });
  assert.throws(() => resolveDesktopDir({ home, platform: 'darwin' }), /start one session/);
  const put = (d, secondsAgo) => {
    fs.mkdirSync(path.join(root, d), { recursive: true });
    const f = path.join(root, d, 'local_x.json');
    fs.writeFileSync(f, '{}');
    const t = (Date.now() - secondsAgo * 1000) / 1000;
    fs.utimesSync(f, t, t);
  };
  put('a1/o1', 500);
  assert.deepEqual(resolveDesktopDir({ home, platform: 'darwin' }), { dir: path.join(root, 'a1', 'o1'), others: [] });
  put('a2/o2', 5);
  fs.mkdirSync(path.join(root, 'a3', 'o3'), { recursive: true });
  const r = resolveDesktopDir({ home, platform: 'darwin' });
  assert.equal(r.dir, path.join(root, 'a2', 'o2'));
  assert.deepEqual(r.others, [path.join(root, 'a1', 'o1')]);
  assert.throws(() => resolveDesktopDir({ home, platform: 'linux' }), /only implemented for macOS/);
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
