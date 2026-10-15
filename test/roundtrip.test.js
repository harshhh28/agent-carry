import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, fakeMachine, readLines, SECRETS } from './helpers.js';
import { buildBundle, writeBundle, readBundle, importBundle } from '../src/bundle.js';
import { mangle } from '../src/paths.js';
import { sha256 } from '../src/transcript.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function setup() {
  const a = tmp('carry-a-');
  const b = tmp('carry-b-');
  const rootA = path.join(a, 'work', 'app');
  const rootB = path.join(b, 'code', 'app');
  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  const m = fakeMachine({ userHome: a, projectRoot: fs.realpathSync(rootA) });
  return { a, b, rootA: fs.realpathSync(rootA), rootB: fs.realpathSync(rootB), m, bClaude: path.join(b, '.claude') };
}

const exportFrom = ({ a, rootA, m }, opts = {}) =>
  buildBundle({ folder: m.folder, id: m.id, where: { store: m.folder, root: rootA, home: a }, ...opts });

test('export then import on another machine rewrites paths, keeps every record, carries sidecars', () => {
  const s = setup();
  const { text, header } = exportFrom(s);
  const file = path.join(s.b, 'x.carry.gz');
  writeBundle(file, text);
  const plan = importBundle({ bundle: readBundle(file), claudeHome: s.bClaude, root: s.rootB, home: s.b });

  const dest = path.join(s.bClaude, 'projects', mangle(s.rootB), `${s.m.id}.jsonl`);
  assert.equal(plan.folder, path.dirname(dest));
  const lines = readLines(dest);
  assert.equal(lines.length, readLines(s.m.main).length, 'same number of lines, including the non-JSON one');
  const blob = fs.readFileSync(dest, 'utf8');
  const withoutThinking = lines
    .map((l) => { try { const r = JSON.parse(l); if (Array.isArray(r.message?.content)) r.message.content = r.message.content.filter((b) => b.type !== 'thinking'); return JSON.stringify(r); } catch { return l; } })
    .join('\n');
  assert.ok(!withoutThinking.includes(s.a), 'no trace of machine A paths outside signed thinking blocks');
  assert.ok(blob.includes(`${s.rootB}/src/app.js`));
  assert.ok(blob.includes('this line is not json'));
  assert.ok(header.pathsRewritten > 0);

  const sub = path.join(path.dirname(dest), s.m.id, 'subagents', 'agent-x.jsonl');
  assert.ok(fs.readFileSync(sub, 'utf8').includes(`explore ${s.rootB}`));
  const tr = path.join(path.dirname(dest), s.m.id, 'tool-results', 'big.txt');
  assert.ok(fs.readFileSync(tr, 'utf8').includes(`${s.rootB}/src/app.js`));
  // the tool_result record points at the sidecar's new location, which exists
  assert.ok(blob.includes(tr), 'reference to the sidecar was rewritten to the target store');
});

test('thinking text and signature survive byte for byte, even though the rest is rewritten', () => {
  const s = setup();
  const file = path.join(s.b, 'x.carry');
  writeBundle(file, exportFrom(s).text);
  importBundle({ bundle: readBundle(file), claudeHome: s.bClaude, root: s.rootB, home: s.b });
  const dest = path.join(s.bClaude, 'projects', mangle(s.rootB), `${s.m.id}.jsonl`);
  const a1 = readLines(dest).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r?.uuid === 'a1');
  const think = a1.message.content[0];
  assert.equal(think.thinking, `I should look in ${s.rootA}/src`);
  assert.equal(think.signature, 'SIG==');
});

test('no planted secret reaches the bundle', () => {
  const s = setup();
  const { text, header } = exportFrom(s);
  for (const v of [SECRETS.anthropic, SECRETS.github, SECRETS.aws, 'whsec_notsosecret12345', 'hunter2hunter2', 'abcdefghijklmnopqrstuvwxyz0123456789']) {
    assert.ok(!text.includes(v), `leaked ${v}`);
  }
  assert.ok(header.redaction.enabled && Object.keys(header.redaction.counts).length > 0);
});

test('--no-redact keeps content and says so in the header', () => {
  const s = setup();
  const { text, header } = exportFrom(s, { redact: false });
  assert.ok(text.includes(SECRETS.github));
  assert.equal(header.redaction.enabled, false);
});

test('importing the same bundle twice is a no-op', () => {
  const s = setup();
  const file = path.join(s.b, 'x.carry');
  writeBundle(file, exportFrom(s).text);
  const args = { bundle: readBundle(file), claudeHome: s.bClaude, root: s.rootB, home: s.b };
  importBundle(args);
  const dest = path.join(s.bClaude, 'projects', mangle(s.rootB), `${s.m.id}.jsonl`);
  const before = fs.readFileSync(dest, 'utf8');
  const plan2 = importBundle(args);
  assert.equal(fs.readFileSync(dest, 'utf8'), before);
  assert.equal(plan2.files.find((f) => f.rel === 'main.jsonl').added, 0);
});

test('a session that continued on both machines merges as a union and keeps local lines first', () => {
  const s = setup();
  const file = path.join(s.b, 'x.carry');
  writeBundle(file, exportFrom(s).text);
  importBundle({ bundle: readBundle(file), claudeHome: s.bClaude, root: s.rootB, home: s.b });
  const dest = path.join(s.bClaude, 'projects', mangle(s.rootB), `${s.m.id}.jsonl`);
  // B continues locally
  fs.appendFileSync(dest, JSON.stringify({ type: 'user', uuid: 'b-only', parentUuid: 'u2', message: { role: 'user', content: 'on B' } }) + '\n');
  // A continues too, then re-exports
  fs.appendFileSync(s.m.main, JSON.stringify({ type: 'user', uuid: 'a-only', parentUuid: 'u2', message: { role: 'user', content: 'on A' } }) + '\n');
  const f2 = path.join(s.b, 'y.carry');
  writeBundle(f2, exportFrom(s).text);
  const plan = importBundle({ bundle: readBundle(f2), claudeHome: s.bClaude, root: s.rootB, home: s.b });
  assert.equal(plan.files.find((f) => f.rel === 'main.jsonl').added, 1);
  const uuids = readLines(dest).map((l) => { try { return JSON.parse(l).uuid; } catch { return null; } });
  assert.ok(uuids.includes('b-only') && uuids.includes('a-only'));
  assert.ok(uuids.indexOf('b-only') < uuids.indexOf('a-only'), 'local order preserved, incoming appended');
  assert.equal(uuids.filter((u) => u === 'u1').length, 1, 'no duplicates');
});

test('a tampered bundle is rejected', () => {
  const s = setup();
  const file = path.join(s.b, 'x.carry');
  writeBundle(file, exportFrom(s).text);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('/.env', '/.enx'));
  assert.throws(() => readBundle(file), /hash mismatch/);
});

test('strip-thinking removes thinking blocks only', () => {
  const s = setup();
  const { text } = exportFrom(s, { stripThinking: true });
  assert.ok(!text.includes('"type":"thinking"'));
  assert.ok(text.includes('"type":"tool_use"'));
});

test('dry run writes nothing', () => {
  const s = setup();
  const file = path.join(s.b, 'x.carry');
  writeBundle(file, exportFrom(s).text);
  importBundle({ bundle: readBundle(file), claudeHome: s.bClaude, root: s.rootB, home: s.b, dryRun: true });
  assert.ok(!fs.existsSync(s.bClaude));
});

test('CLI: list, export --latest, inspect, import', () => {
  const s = setup();
  const run = (args, cwd) => execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
  const listed = run(['list', '--claude-home', s.m.claude], s.rootA);
  assert.match(listed, /11111111/);
  assert.match(listed, /Fix the app/);
  const out = path.join(s.b, 'cli.carry.gz');
  run(['export', '--latest', '-o', out, '--claude-home', s.m.claude, '--home', s.a], s.rootA);
  assert.match(run(['inspect', out]), /"sessionId": "11111111/);
  const res = run(['import', out, '--claude-home', s.bClaude, '--home', s.b], s.rootB);
  assert.match(res, /claude --resume 11111111/);
  assert.ok(fs.existsSync(path.join(s.bClaude, 'projects', mangle(s.rootB), `${s.m.id}.jsonl`)));
});

test('import refuses sidecar paths that escape the project folder', () => {
  const s = setup();
  const { header } = exportFrom(s);
  const body = JSON.stringify({ p: 'side/../../../escape.txt', t: 'x' }) + '\n';
  const file = path.join(s.b, 'evil.carry');
  fs.writeFileSync(file, JSON.stringify({ ...header, bodySha256: sha256(body) }) + '\n' + body);
  assert.throws(() => importBundle({ bundle: readBundle(file), claudeHome: s.bClaude, root: s.rootB, home: s.b }), /outside project folder/);
  assert.ok(!fs.existsSync(path.join(s.b, 'escape.txt')));
});

function plantThinkingSecret(s) {
  const lines = fs.readFileSync(s.m.main, 'utf8').split('\n');
  const i = lines.findIndex((l) => l.includes('"uuid":"a1"'));
  const r = JSON.parse(lines[i]);
  r.message.content[0].thinking = `the key is ${SECRETS.github}`;
  lines[i] = JSON.stringify(r);
  fs.writeFileSync(s.m.main, lines.join('\n'));
}

test('credential-like strings in signed thinking blocks: export refuses by default, with a way out', () => {
  const s = setup();
  plantThinkingSecret(s);
  assert.throws(() => exportFrom(s), (e) => e.code === 'THINKING_SECRETS' && /--strip-thinking/.test(e.message));
  assert.equal(exportFrom(s, { stripThinking: true }).header.thinking.possibleSecrets, 0);
  assert.equal(exportFrom(s, { allowThinkingSecrets: true }).header.thinking.possibleSecrets, 1);
});

test('repeated bookkeeping lines keep their order on a fresh import (last one wins)', () => {
  const s = setup();
  const mode = (m) => JSON.stringify({ type: 'mode', mode: m, sessionId: s.m.id });
  fs.appendFileSync(s.m.main, [mode('plan'), mode('default')].join('\n') + '\n');
  const file = path.join(s.b, 'x.carry');
  writeBundle(file, exportFrom(s).text);
  importBundle({ bundle: readBundle(file), claudeHome: s.bClaude, root: s.rootB, home: s.b });
  const dest = path.join(s.bClaude, 'projects', mangle(s.rootB), `${s.m.id}.jsonl`);
  const modes = readLines(dest).filter((l) => l.startsWith('{"type":"mode"')).map((l) => JSON.parse(l).mode);
  assert.deepEqual(modes, ['default', 'plan', 'default']);
});

test('bundles name their agent; an unknown agent is refused clearly, an unlabelled old bundle is accepted', () => {
  const s = setup();
  const { header } = exportFrom(s);
  assert.equal(header.agent, 'claude-code');
  const body = JSON.stringify({ p: 'main.jsonl', x: 'line' }) + '\n';
  const write = (h, name) => {
    const f = path.join(s.b, name);
    fs.writeFileSync(f, JSON.stringify({ ...h, bodySha256: sha256(body) }) + '\n' + body);
    return f;
  };
  assert.throws(() => readBundle(write({ ...header, agent: 'codex' }, 'codex.carry')), /agent "codex".*supports: claude-code/);
  const { agent, ...legacy } = header;
  void agent;
  assert.doesNotThrow(() => readBundle(write(legacy, 'legacy.carry')));
});

test('export: an id present in two project folders needs --project, which pins it', () => {
  const s = setup();
  const other = path.join(s.b, 'copy');
  fs.mkdirSync(other, { recursive: true });
  const run = (args, cwd) => execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const first = path.join(s.b, 'a.carry.gz');
  run(['export', '--latest', '-o', first, '--claude-home', s.m.claude, '--home', s.a], s.rootA);
  run(['import', first, '--claude-home', s.m.claude, '--home', s.a], other);
  assert.throws(() => run(['export', '11111111', '-o', path.join(s.b, 'x.gz'), '--claude-home', s.m.claude, '--home', s.a], s.b), /more than one session.*--project/s);
  assert.doesNotThrow(() => run(['export', '11111111', '--project', s.rootA, '-o', path.join(s.b, 'y.gz'), '--claude-home', s.m.claude, '--home', s.a], s.b));
});

test('CLI: --version, and export refuses on thinking secrets until told otherwise', () => {
  const s = setup();
  const run = (args, cwd) => execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(run(['--version'], s.rootA), /^\d+\.\d+\.\d+\n$/);
  plantThinkingSecret(s);
  const base = ['export', '--latest', '--claude-home', s.m.claude, '--home', s.a, '-o'];
  assert.throws(() => run([...base, path.join(s.b, 'a.gz')], s.rootA), /--strip-thinking/);
  assert.doesNotThrow(() => run([...base, path.join(s.b, 'b.gz'), '--strip-thinking'], s.rootA));
  assert.doesNotThrow(() => run([...base, path.join(s.b, 'c.gz'), '--allow-thinking-secrets'], s.rootA));
});
