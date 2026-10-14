import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, fakeMachine, readLines, SECRETS } from './helpers.js';
import { encrypt, decrypt, isEncrypted } from '../src/crypto.js';
import { pushProject, pullProject, projectKey } from '../src/sync.js';
import { mangle } from '../src/paths.js';
import { buildBundle, writeBundle, readBundle } from '../src/bundle.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function twoDevices() {
  const shared = tmp('carry-shared-');
  const mk = (label) => {
    const home = tmp(`carry-${label}-`);
    const root = path.join(home, 'work', 'app');
    fs.mkdirSync(root, { recursive: true });
    return { home, root, claude: path.join(home, '.claude'), cfg: path.join(home, 'cfg') };
  };
  const A = mk('a');
  const B = mk('b');
  const m = fakeMachine({ userHome: A.home, projectRoot: A.root });
  fs.mkdirSync(path.join(B.claude, 'projects'), { recursive: true });
  const opts = (d, extra = {}) => ({ dir: shared, claudeHome: d.claude, root: d.root, userHome: d.home, cfg: d.cfg, name: 'app', ...extra });
  return { shared, A, B, m, opts };
}

test('crypto round trip, wrong passphrase and tampering are detected', () => {
  const enc = encrypt(Buffer.from('hello session'), 'pw');
  assert.ok(isEncrypted(enc));
  assert.ok(!enc.includes('hello'));
  assert.equal(decrypt(enc, 'pw').toString(), 'hello session');
  assert.throws(() => decrypt(enc, 'nope'), /wrong passphrase/);
  const bad = Buffer.from(enc);
  bad[30] ^= 1;
  assert.throws(() => decrypt(bad, 'pw'), /wrong passphrase|modified/);
  assert.throws(() => decrypt(enc, undefined), /encrypted/);
});

test('encrypted bundle: nothing readable on disk, round trips with the passphrase', () => {
  const s = twoDevices();
  const { text } = buildBundle({ folder: s.m.folder, id: s.m.id, where: { store: s.m.folder, root: s.A.root, home: s.A.home } });
  const f = path.join(s.shared, 'x.carry.enc');
  writeBundle(f, text, { passphrase: 'pw' });
  const raw = fs.readFileSync(f);
  assert.ok(!raw.includes('Fix the app') && !raw.includes('sessionId'));
  assert.equal(readBundle(f, { passphrase: 'pw' }).header.title, 'Fix the app');
  assert.throws(() => readBundle(f), /encrypted/);
  assert.throws(() => readBundle(f, { passphrase: 'x' }), /wrong passphrase/);
});

test('push then pull moves a session between devices with paths rewritten', () => {
  const s = twoDevices();
  const push = pushProject(s.opts(s.A));
  assert.equal(push.pushed, 1);
  const pull = pullProject(s.opts(s.B));
  assert.equal(pull.imported, 1);
  const dest = path.join(s.B.claude, 'projects', mangle(s.B.root), `${s.m.id}.jsonl`);
  const blob = fs.readFileSync(dest, 'utf8');
  assert.ok(blob.includes(`${s.B.root}/src/app.js`));
  assert.equal(readLines(dest).length, readLines(s.m.main).length);
});

test('push is idempotent: unchanged sessions are not rewritten (sync tools see no churn)', () => {
  const s = twoDevices();
  pushProject(s.opts(s.A));
  const f = path.join(s.shared, 'app', s.m.id, fs.readdirSync(path.join(s.shared, 'app', s.m.id))[0]);
  const before = fs.statSync(f).mtimeMs;
  const again = pushProject(s.opts(s.A));
  assert.equal(again.unchanged, 1);
  assert.equal(again.pushed, 0);
  assert.equal(fs.statSync(f).mtimeMs, before);
});

test('two devices that both continued a session converge without conflicts', () => {
  const s = twoDevices();
  pushProject(s.opts(s.A));
  pullProject(s.opts(s.B));
  const destB = path.join(s.B.claude, 'projects', mangle(s.B.root), `${s.m.id}.jsonl`);
  fs.appendFileSync(destB, JSON.stringify({ type: 'user', uuid: 'b-1', parentUuid: 'u2', message: { role: 'user', content: 'from B' } }) + '\n');
  fs.appendFileSync(s.m.main, JSON.stringify({ type: 'user', uuid: 'a-1', parentUuid: 'u2', message: { role: 'user', content: 'from A' } }) + '\n');
  pushProject(s.opts(s.A));
  pushProject(s.opts(s.B));
  assert.equal(fs.readdirSync(path.join(s.shared, 'app', s.m.id)).length, 2, 'one file per device, single writer each');
  pullProject(s.opts(s.A));
  pullProject(s.opts(s.B));
  const ids = (f) => new Set(readLines(f).map((l) => { try { return JSON.parse(l).uuid; } catch { return null; } }));
  const onA = ids(s.m.main);
  const onB = ids(destB);
  for (const u of ['a-1', 'b-1', 'u1', 'u2']) assert.ok(onA.has(u) && onB.has(u), `${u} on both`);
});

test('pull skips files it has already imported and never re-imports its own', () => {
  const s = twoDevices();
  pushProject(s.opts(s.A));
  assert.equal(pullProject(s.opts(s.A)).sessions, 0, 'own file ignored');
  pullProject(s.opts(s.B));
  const second = pullProject(s.opts(s.B));
  assert.equal(second.imported, 0);
  assert.equal(second.upToDate, 1);
});

test('encrypted folder sync: shared folder holds no readable content or secrets, wrong key errors', () => {
  const s = twoDevices();
  pushProject(s.opts(s.A, { passphrase: 'correct horse' }));
  const files = fs.readdirSync(path.join(s.shared, 'app', s.m.id));
  assert.match(files[0], /\.carry\.enc$/);
  const raw = fs.readFileSync(path.join(s.shared, 'app', s.m.id, files[0]));
  for (const needle of ['Fix the app', 'app.js', SECRETS.github, 'sessionId']) assert.ok(!raw.includes(needle));
  const bad = pullProject(s.opts(s.B, { passphrase: 'wrong' }));
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /wrong passphrase/);
  assert.equal(pullProject(s.opts(s.B, { passphrase: 'correct horse' })).imported, 1);
});

test('project key follows the git remote, not the path', () => {
  const a = tmp('k-a-');
  const b = tmp('k-b-');
  for (const [d, url] of [[a, 'git@github.com:acme/app.git'], [b, 'https://github.com/acme/app']]) {
    fs.mkdirSync(path.join(d, 'x'));
    execFileSync('git', ['init', '-q'], { cwd: path.join(d, 'x') });
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: path.join(d, 'x') });
  }
  assert.equal(projectKey(path.join(a, 'x')), projectKey(path.join(b, 'x')));
  assert.equal(projectKey('/nowhere/Some Dir'), 'some-dir');
  assert.equal(projectKey('/x', 'My Name'), 'my-name');
});

test('CLI push/pull with env passphrase', () => {
  const s = twoDevices();
  const env = (d) => ({ ...process.env, CARRY_HOME: d.cfg, CARRY_PASSPHRASE: 'pw' });
  const run = (args, d) => execFileSync('node', [CLI, ...args], { cwd: d.root, env: env(d), encoding: 'utf8' });
  assert.match(run(['push', s.shared, '--name', 'app', '--claude-home', s.A.claude, '--home', s.A.home], s.A), /1 written.*encrypted/);
  assert.match(run(['pull', s.shared, '--name', 'app', '--claude-home', s.B.claude, '--home', s.B.home], s.B), /1 session\(s\) updated/);
  assert.equal(run(['pull', s.shared, '--name', 'app', '--quiet', '--claude-home', s.B.claude, '--home', s.B.home], s.B), '');
});
