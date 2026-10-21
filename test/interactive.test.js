import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, fakeMachine } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const run = (args, opts = {}) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });

function machine() {
  const a = tmp('carry-a-');
  const root = path.join(a, 'work', 'app');
  fs.mkdirSync(root, { recursive: true });
  const rootReal = fs.realpathSync(root);
  const m = fakeMachine({ userHome: a, projectRoot: rootReal });
  return { a, root: rootReal, m, base: ['--claude-home', m.claude, '--home', a, '--project-root', rootReal] };
}

test('--generate-passphrase encrypts, saves the passphrase beside the bundle (0600) and never prints it', () => {
  const s = machine();
  const out = path.join(s.a, 'g.carry.enc');
  const printed = run(['export', '--latest', '-o', out, '--generate-passphrase', ...s.base]);
  const pass = fs.readFileSync(`${out}.pass`, 'utf8').trim();
  assert.ok(pass.length >= 24);
  assert.ok(!printed.includes(pass), 'passphrase must not appear in output');
  assert.match(printed, /passphrase saved to .*\.pass \(not printed\)/);
  assert.equal(fs.statSync(`${out}.pass`).mode & 0o777, 0o600);
  assert.throws(() => run(['inspect', out]), /encrypted/);
  const header = JSON.parse(run(['inspect', out, '--passphrase-file', `${out}.pass`]));
  assert.equal(header.sessionId, s.m.id);
});

test('--generate-passphrase refuses to be combined with a passphrase of your own', () => {
  const s = machine();
  const pf = path.join(s.a, 'p.txt');
  fs.writeFileSync(pf, 'mine');
  assert.throws(() => run(['export', '--latest', '-o', path.join(s.a, 'x.enc'), '--generate-passphrase', '--passphrase-file', pf, ...s.base]), /either/);
});

test('bundles lists bundle files, newest first, saying which are encrypted and what the plain ones hold', () => {
  const s = machine();
  const dl = path.join(s.a, 'Downloads');
  fs.mkdirSync(dl);
  run(['export', '--latest', '-o', path.join(dl, 'plain.carry.gz'), ...s.base]);
  run(['export', '--latest', '-o', path.join(dl, 'locked.carry.enc'), '--generate-passphrase', ...s.base]);
  fs.utimesSync(path.join(dl, 'plain.carry.gz'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const out = run(['bundles', '--home', s.a], { cwd: s.a });
  const lines = out.split('\n').filter((l) => l.startsWith('/'));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].endsWith('locked.carry.enc'), 'newest first');
  assert.match(out, /encrypted {2}.*needs its passphrase/);
  assert.match(out, /plain {2}.*"Fix the app", 2 turn\(s\), session 11111111/);
  assert.match(run(['bundles', '--home', tmp()], { cwd: tmp() }), /no .carry.gz or .carry.enc files found/);
});

function twoSessionMachine() {
  const s = machine();
  const folder = s.m.folder;
  const mk = (id, entrypoint, text, mtime) => {
    const f = path.join(folder, `${id}.jsonl`);
    fs.writeFileSync(f, JSON.stringify({ type: 'user', uuid: `u-${id}`, parentUuid: null, sessionId: id, cwd: s.root, entrypoint, timestamp: '2026-10-14T09:00:00Z', message: { role: 'user', content: text } }) + '\n');
    fs.utimesSync(f, mtime, mtime);
  };
  const now = Date.now() / 1000;
  mk('aaaaaaaa-0000-0000-0000-000000000001', 'claude-desktop', 'build the login page', now - 30);
  mk('bbbbbbbb-0000-0000-0000-000000000002', 'sdk-ts', 'background observer chatter', now - 10);
  mk('cccccccc-0000-0000-0000-000000000003', 'cli', 'older terminal session', now - 600);
  fs.utimesSync(s.m.main, now - 3000, now - 3000);
  return s;
}

test('list --all spans folders, hides background-agent sessions, and uses the desktop app title', () => {
  const s = twoSessionMachine();
  const dd = path.join(s.a, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(dd, 'local_1.json'), JSON.stringify({ sessionId: 'local_1', cliSessionId: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Login page work' }));
  const out = run(['list', '--all', '--claude-home', s.m.claude, '--home', s.a]);
  const lines = out.split('\n').filter(Boolean);
  assert.match(lines[0], /^aaaaaaaa .*Login page work {2}\[desktop app\]/, 'newest first, with the desktop title');
  assert.ok(!out.includes('bbbbbbbb'), 'background agent hidden');
  assert.match(out, /cccccccc .*older terminal session/);
  assert.match(out, /11111111 .*Fix the app/);
  assert.ok(run(['list', '--all', '--everything', '--claude-home', s.m.claude, '--home', s.a]).includes('bbbbbbbb'));
  assert.equal(run(['list', '--all', '--limit', '1', '--claude-home', s.m.claude, '--home', s.a]).split('\n').filter((l) => /^[0-9a-f]{8} /.test(l)).length, 1);
});

test('export with no id shows a numbered list and exports the chosen session, from any folder', () => {
  const s = twoSessionMachine();
  const out = path.join(s.a, 'picked.carry.gz');
  const cwd = tmp('carry-elsewhere-');
  const r = run(['export', '-o', out, '--claude-home', s.m.claude, '--home', s.a], { cwd, input: '2\n' });
  assert.match(r, / 2\. cccccccc .*older terminal session/);
  assert.match(r, /exported cccccccc/);
  assert.ok(fs.existsSync(out));
  assert.match(run(['export', '-o', path.join(s.a, 'd.carry.gz'), '--claude-home', s.m.claude, '--home', s.a], { cwd, input: '\n' }), /exported aaaaaaaa/, 'Enter takes the first');
  assert.throws(() => run(['export', '-o', path.join(s.a, 'x.carry.gz'), '--claude-home', s.m.claude, '--home', s.a], { cwd, input: '9\n' }), /not one of the numbers/);
  assert.throws(() => run(['export', '-o', path.join(s.a, 'y.carry.gz'), '--claude-home', s.m.claude, '--home', s.a], { cwd, input: '' }), /no session chosen/);
});
