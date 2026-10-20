import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, fakeMachine } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const run = (args, opts = {}) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

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
