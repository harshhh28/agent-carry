import test from 'node:test';
import assert from 'node:assert/strict';
import { mangle } from '../src/paths.js';
import { toPortable, fromPortable, mapStrings } from '../src/portable.js';
import { makeRedactor } from '../src/redact.js';
import { SECRETS } from './helpers.js';

test('mangle replaces every non-alphanumeric character', () => {
  assert.equal(mangle('/Users/a/Documents/dnd'), '-Users-a-Documents-dnd');
  assert.equal(mangle('/private/tmp/claude-501/x_y.z'), '-private-tmp-claude-501-x-y-z');
});

const A = { store: '/Users/a/.claude/projects/-Users-a-work-app', root: '/Users/a/work/app', home: '/Users/a' };
const B = { store: '/home/b/.claude/projects/-home-b-code-app', root: '/home/b/code/app', home: '/home/b' };

test('paths round-trip from machine A to machine B', () => {
  const s = `cd ${A.root}/src && cat ${A.home}/.zshrc && ls ${A.store}/x/tool-results/y.txt`;
  const portable = toPortable(A).fn(s);
  assert.equal(portable, 'cd ${CARRY_ROOT}/src && cat ${CARRY_HOME}/.zshrc && ls ${CARRY_STORE}/x/tool-results/y.txt');
  const onB = fromPortable(B).fn(portable);
  assert.equal(onB, `cd ${B.root}/src && cat ${B.home}/.zshrc && ls ${B.store}/x/tool-results/y.txt`);
  assert.ok(!onB.includes('/Users/a'));
});

test('prefix matching respects path boundaries', () => {
  const f = toPortable({ ...A, home: '/nohome' }).fn;
  assert.equal(f(`${A.root}-two/x`), `${A.root}-two/x`, 'sibling with suffix untouched');
  assert.equal(f(`${A.root}.bak`), `${A.root}.bak`, 'extension untouched');
  assert.equal(f(`/srv${A.root}`), `/srv${A.root}`, 'embedded in a longer path untouched');
  assert.equal(f(`see ${A.root}.`), 'see ${CARRY_ROOT}.', 'trailing sentence period still matches');
  assert.equal(f(`"${A.root}"`), '"${CARRY_ROOT}"');
  assert.equal(f(`../..${A.root}/x`), '../..${CARRY_ROOT}/x', 'relative traversal text still tokenised');
  assert.equal(f(`\u001b[36m${A.root}/x`), '\u001b[36m${CARRY_ROOT}/x', 'path right after a colour escape');
  assert.equal(f(`\${PLUGIN_ROOT:-${A.root}/x}`), '${PLUGIN_ROOT:-${CARRY_ROOT}/x}', 'shell default value');
  assert.equal(f(`u001b[36m${A.root}`), 'u001b[36m${CARRY_ROOT}', 'doubly escaped colour code');
  assert.equal(f(`line one\\n${A.root}/x`), 'line one\\n${CARRY_ROOT}/x', 'literal backslash-n before a path');
});

test('thinking blocks are never modified', () => {
  const rec = { message: { content: [{ type: 'thinking', thinking: `in ${A.root}`, signature: 's' }, { type: 'text', text: A.root }] } };
  const out = mapStrings(rec, toPortable(A).fn);
  assert.equal(out.message.content[0].thinking, `in ${A.root}`);
  assert.equal(out.message.content[1].text, '${CARRY_ROOT}');
});

test('untouched records are returned by identity', () => {
  const rec = { a: 'nothing here', b: [1, 2, { c: 'x' }] };
  assert.equal(mapStrings(rec, toPortable(A).fn), rec);
});

test('redaction removes known secret shapes and keeps ordinary text', () => {
  const r = makeRedactor();
  const text = [SECRETS.anthropic, SECRETS.github, SECRETS.aws, SECRETS.envLine, SECRETS.bearer, SECRETS.dburl, 'plain sentence about tokens in general'].join('\n');
  const out = r.fn(text);
  for (const s of [SECRETS.anthropic, SECRETS.github, SECRETS.aws, 'whsec_notsosecret12345', 'abcdefghijklmnopqrstuvwxyz0123456789', 'hunter2hunter2']) {
    assert.ok(!out.includes(s), `leaked: ${s}`);
  }
  assert.ok(out.includes('plain sentence about tokens in general'));
  assert.ok(out.includes('STRIPE_SECRET_KEY='), 'variable name kept so the context stays readable');
  assert.ok(Object.keys(r.counts).length >= 5);
});

test('emails are only redacted when asked', () => {
  assert.ok(makeRedactor().fn('me@example.com').includes('me@example.com'));
  assert.equal(makeRedactor({ emails: true }).fn('me@example.com'), '[REDACTED:email]');
});

test('object keys are rewritten too (file-history snapshots are keyed by absolute path)', () => {
  const rec = { type: 'file-history-snapshot', snapshot: { trackedFileBackups: { [`${A.root}/src/a.js`]: { version: 1 } } } };
  const out = mapStrings(rec, toPortable(A).fn);
  assert.deepEqual(Object.keys(out.snapshot.trackedFileBackups), ['${CARRY_ROOT}/src/a.js']);
  const back = mapStrings(out, fromPortable(B).fn);
  assert.deepEqual(Object.keys(back.snapshot.trackedFileBackups), [`${B.root}/src/a.js`]);
});

test('redaction closes the gaps found in review: ANSI-prefixed env, lowercase names, escaped JSON, base64', () => {
  const PW = 'S3cr3tPassw0rd!x';
  const r = () => makeRedactor();
  const cases = {
    'ansi-prefixed env': `\u001b[31mDB_PASSWORD=${PW}\u001b[0m`,
    'ansi, doubly escaped colour': `u001b[31mDB_PASSWORD=${PW}`,
    'lowercase name': `connect with password=${PW} now`,
    'lowercase colon': `api_key: ${PW}${PW}`,
    'quoted': `SECRET_TOKEN="${PW}"`,
    'escaped json': `{"note": "${JSON.stringify({ token: PW + 'zz' }).replace(/"/g, '\\"')}"}`,
    'double escaped json': JSON.stringify(JSON.stringify({ api_key: PW + 'zz' })),
    'base64': 'b64 ' + Buffer.from('aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY').toString('base64'),
    'base64 of a bearer': Buffer.from('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789').toString('base64'),
  };
  for (const [name, text] of Object.entries(cases)) {
    const out = r().fn(text);
    assert.ok(!out.includes(PW) && !out.includes('wJalrXUtnFEMI') && !out.includes('abcdefghijklmnopqrstuvwxyz'), `${name} leaked: ${out}`);
    assert.ok(!out.includes(Buffer.from('aws_secret_access_key=wJal').toString('base64').slice(0, 20)), `${name} base64 leaked`);
  }
});

test('redaction leaves ordinary text, hashes and placeholders alone, and is idempotent', () => {
  const calm = [
    'max_tokens = 4096 and token count is fine',
    'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'The password field is required.',
    'const token = parseToken(request)',
    'tokenHash: abcdefghijklmnop and max_tokens=ninetynine',
    'password=correcthorsebatterystaple',
    'Ym9vbGVhbiBub3RoaW5nIGludGVyZXN0aW5nIGhlcmUgYXQgYWxs',
  ];
  for (const t of calm) assert.equal(makeRedactor().fn(t), t, t);
  const once = makeRedactor().fn('STRIPE_SECRET_KEY=abcdefghijklmnop');
  const r2 = makeRedactor();
  assert.equal(r2.fn(once), once);
  assert.deepEqual(r2.counts, {}, 'placeholders are not re-counted');
});
