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
  assert.match(lines[0], /^aaaaaaaa .*Login page work {2}\[desktop\]/, 'newest first, with the desktop title');
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

test('list: a single folder via --project, and --match narrows by title or folder', () => {
  const s = twoSessionMachine();
  const base = ['--claude-home', s.m.claude, '--home', s.a];
  const here = run(['list', '--project', s.root, ...base]);
  assert.match(here, /aaaaaaaa/);
  assert.match(here, /11111111/);
  assert.ok(!run(['list', '--project', path.join(s.a, 'elsewhere'), ...base]).includes('aaaaaaaa'));
  assert.match(run(['list', '--project', path.join(s.a, 'elsewhere'), ...base]), /no sessions found .*; try: carry list --all/);
  const byTitle = run(['list', '--all', '--match', 'login page', ...base]);
  assert.match(byTitle, /aaaaaaaa/);
  assert.ok(!byTitle.includes('cccccccc'));
  assert.match(run(['list', '--all', '--match', 'work/app', ...base]), /cccccccc/, 'matches the folder too');
  assert.match(run(['list', '--all', '--match', 'zzz-nothing', ...base]), /no sessions found for any project matching "zzz-nothing"/);
});

test('list --desktop and --terminal filter by where the session was started; archived and imported ones are tagged', () => {
  const s = twoSessionMachine();
  const base = ['--claude-home', s.m.claude, '--home', s.a];
  const idx = path.join(s.a, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(idx, { recursive: true });
  // a terminal-born session that the desktop app lists (e.g. imported with --desktop), and an archived one
  const mk = (id, entrypoint) => fs.writeFileSync(path.join(s.m.folder, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd: s.root, entrypoint, timestamp: '2026-10-14T09:00:00Z', message: { role: 'user', content: `prompt ${id}` } }) + '\n');
  mk('dddddddd-0000-0000-0000-000000000004', 'cli');
  mk('eeeeeeee-0000-0000-0000-000000000005', 'claude-desktop');
  fs.writeFileSync(path.join(idx, 'local_a.json'), JSON.stringify({ cliSessionId: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Login page work' }));
  fs.writeFileSync(path.join(idx, 'local_d.json'), JSON.stringify({ cliSessionId: 'dddddddd-0000-0000-0000-000000000004', title: 'Imported one' }));
  fs.writeFileSync(path.join(idx, 'local_e.json'), JSON.stringify({ cliSessionId: 'eeeeeeee-0000-0000-0000-000000000005', title: 'Old chat', isArchived: true }));
  const desk = run(['list', '--all', '--desktop', ...base]);
  assert.match(desk, /aaaaaaaa .*\[desktop\]/);
  assert.match(desk, /dddddddd .*Imported one {2}\[desktop\]/, 'listed by the app, so it counts as desktop');
  assert.match(desk, /eeeeeeee .*\[desktop, archived\]/);
  assert.ok(!desk.includes('cccccccc') && !desk.includes('11111111'), 'terminal sessions excluded');
  const term = run(['list', '--all', '--terminal', ...base]);
  assert.match(term, /cccccccc .*\[terminal\]/);
  assert.match(term, /11111111 .*\[terminal\]/);
  assert.ok(!term.includes('aaaaaaaa') && !term.includes('dddddddd'));
  assert.throws(() => run(['list', '--all', '--desktop', '--terminal', ...base]), /not both/);
  assert.match(run(['list', '--all', '--desktop', '--match', 'zzz', ...base]), /no desktop sessions found for any project matching "zzz"/);
  const out = path.join(s.a, 'dp.carry.gz');
  assert.match(run(['export', '--desktop', '-o', out, ...base], { cwd: tmp(), input: '3\n' }), /exported aaaaaaaa/, 'the export picker honours --desktop');
});

test('a desktop session with no project folder shows a readable location', () => {
  const s = machine();
  const acct = '6e111bcf-e19b-4d00-8011-bb08465b18b9';
  const scratch = path.join(s.a, 'Library', 'Application Support', 'Claude', 'scratch-workspaces', acct, 'c83f5676-c889-4b53-9a50-f1414a4f8764', 'scratch-2026-10-20');
  fs.mkdirSync(scratch, { recursive: true });
  const folder = path.join(s.m.claude, 'projects', 'scratch-folder');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'ffffffff-0000-0000-0000-000000000006.jsonl'), JSON.stringify({ type: 'user', uuid: 'u-f', sessionId: 'f', cwd: scratch, entrypoint: 'claude-desktop', timestamp: '2026-10-20T09:00:00Z', message: { role: 'user', content: 'quick question' } }) + '\n');
  const out = run(['list', '--all', '--desktop', '--claude-home', s.m.claude, '--home', s.a]);
  assert.match(out, /\(desktop scratch folder: scratch-2026-10-20\)/);
  assert.ok(!out.includes('c83f5676'));
});
