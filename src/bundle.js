import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseJsonl, summarize, sha256 } from './transcript.js';
import { toPortable, fromPortable, mapStrings, residualHomePaths, TOKENS } from './portable.js';
import { makeRedactor } from './redact.js';
import { mergeEntries } from './merge.js';
import { mangle, realpathOr, projectsDir } from './paths.js';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import { readSession } from './store.js';

export const FORMAT = 1;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024; // refuse decompression bombs

export const TOOL = 'agent-carry/0.1.0';

/** Agents this build can read and write. Bundles name their agent so other adapters can be added without a format change. */
export const AGENT = 'claude-code';
const SUPPORTED_AGENTS = new Set([AGENT]);

/**
 * Bundle = newline-delimited JSON, readable with `less` and `jq`:
 *   line 1   header (what is inside, counts, redaction report, body hash)
 *   line 2+  {"p": part, "l": record} | {"p": part, "x": unparsable line}
 *            | {"p": part, "t": text file} | {"p": part, "b": base64 file}
 * A `.gz` suffix gzips the whole thing.
 */

export function buildBundle({ folder, id, where, redact = true, emails = false, stripThinking = false, allowThinkingSecrets = false }) {
  const { parts, skipped } = readSession(folder, id);
  const mapper = toPortable(where);
  const redactor = redact ? makeRedactor({ emails }) : null;
  const transform = (v) => {
    let out = mapStrings(v, mapper.fn);
    if (redactor) out = redactor.apply(out);
    return out;
  };

  const body = [];
  const thinking = { blocks: 0, possibleSecrets: 0 };
  const partsMeta = [];
  const residualSource = [];
  let meta = null;

  for (const part of parts) {
    let count = 0;
    if (part.kind === 'jsonl') {
      const entries = parseJsonl(part.text);
      if (part.rel === 'main.jsonl') meta = summarize(entries);
      for (const { raw, rec } of entries) {
        if (rec === null) {
          const t = transform(raw);
          body.push(JSON.stringify({ p: part.rel, x: t }));
          residualSource.push(t);
        } else {
          let r = stripThinking ? dropThinking(rec) : rec;
          if (!stripThinking) scanThinking(r, thinking);
          r = transform(r);
          body.push(JSON.stringify({ p: part.rel, l: r }));
          residualSource.push(JSON.stringify(r));
        }
        count++;
      }
    } else if (part.kind === 'text') {
      const t = transform(part.text);
      body.push(JSON.stringify({ p: part.rel, t }));
      residualSource.push(t);
      count = 1;
    } else {
      body.push(JSON.stringify({ p: part.rel, b: part.base64 }));
      count = 1;
    }
    partsMeta.push({ rel: part.rel, kind: part.kind, count });
  }

  if (redact && !stripThinking && !allowThinkingSecrets && thinking.possibleSecrets > 0) {
    const e = new Error(
      `${thinking.possibleSecrets} credential-like string(s) in ${thinking.blocks} signed thinking block(s) cannot be redacted (editing a thinking block invalidates it). ` +
        'Re-run with --strip-thinking to drop thinking blocks, or --allow-thinking-secrets to export them as they are.',
    );
    e.code = 'THINKING_SECRETS';
    throw e;
  }
  const bodyText = body.join('\n') + '\n';
  const header = {
    carry: FORMAT,
    agent: AGENT,
    tool: TOOL,
    createdAt: new Date().toISOString(),
    sessionId: id,
    title: meta?.title ?? null,
    claudeVersions: meta?.versions ?? [],
    entrypoints: meta?.entrypoints ?? [],
    turns: meta?.turns ?? 0,
    tokens: TOKENS,
    parts: partsMeta,
    skippedLarge: skipped,
    redaction: redactor ? { enabled: true, emails, counts: redactor.counts } : { enabled: false },
    thinkingStripped: stripThinking,
    thinking,
    pathsRewritten: mapper.stats.replaced,
    residualHomePaths: residualHomePaths(residualSource).size,
    bodySha256: sha256(bodyText),
  };
  return { text: JSON.stringify(header) + '\n' + bodyText, header };
}

/**
 * Thinking blocks are signed, so they travel unmodified: neither path-rewritten
 * nor redacted. Count credential-shaped strings inside them so the exporter can
 * warn instead of silently shipping them.
 */
function scanThinking(rec, acc) {
  const c = rec?.message?.content;
  if (!Array.isArray(c)) return;
  for (const b of c) {
    if (!b || b.type !== 'thinking' || typeof b.thinking !== 'string') continue;
    acc.blocks++;
    const probe = makeRedactor();
    probe.fn(b.thinking);
    acc.possibleSecrets += Object.values(probe.counts).reduce((a, n) => a + n, 0);
  }
}

function dropThinking(rec) {
  const c = rec?.message?.content;
  if (!Array.isArray(c)) return rec;
  const kept = c.filter((b) => !(b && (b.type === 'thinking' || b.type === 'redacted_thinking')));
  return kept.length === c.length ? rec : { ...rec, message: { ...rec.message, content: kept } };
}

/** Atomic (temp + rename) so a file-sync tool never uploads a half-written bundle. */
export function writeBundle(file, text, { passphrase } = {}) {
  let data = Buffer.from(text);
  if (file.endsWith('.gz') || file.endsWith('.enc') || passphrase) data = zlib.gzipSync(data);
  if (passphrase) data = encrypt(data, passphrase);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.carry-tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function readBundle(file, { passphrase } = {}) {
  if (fs.statSync(file).size > MAX_BUNDLE_BYTES) throw new Error('bundle is larger than 1 GB; refusing to read it');
  let buf = fs.readFileSync(file);
  if (isEncrypted(buf)) buf = decrypt(buf, passphrase);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_BUNDLE_BYTES });
  const text = buf.toString('utf8');
  const nl = text.indexOf('\n');
  if (nl < 0) throw new Error('not a carry bundle (no header)');
  let header;
  try {
    header = JSON.parse(text.slice(0, nl));
  } catch {
    throw new Error('not a carry bundle (bad header)');
  }
  if (header.carry !== FORMAT) throw new Error(`unsupported bundle format ${header.carry} (this tool reads ${FORMAT})`);
  // Bundles written before the field existed were all Claude Code.
  const agent = header.agent ?? AGENT;
  if (!SUPPORTED_AGENTS.has(agent)) {
    throw new Error(`bundle is for agent "${agent}"; this version of agent-carry supports: ${[...SUPPORTED_AGENTS].join(', ')}`);
  }
  const bodyText = text.slice(nl + 1);
  if (sha256(bodyText) !== header.bodySha256) throw new Error('bundle is corrupt or was modified: body hash mismatch');
  const rows = bodyText.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { header, rows };
}

/**
 * Write a bundle into a Claude home for a target project root. Returns a plan;
 * with dryRun it writes nothing.
 */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** `stripAnsi` drops terminal colour codes from incoming text, for apps that show them as literal characters. */
export function importBundle({ bundle, claudeHome, root, home, dryRun = false, stripAnsi = false }) {
  const realRoot = realpathOr(root);
  const folder = path.join(projectsDir(claudeHome), mangle(realRoot));
  const where = { store: folder, root: realRoot, home };
  const back = fromPortable(where);
  const text = stripAnsi ? (v) => back.fn(v).replace(ANSI, '') : back.fn;
  const id = bundle.header.sessionId;
  const plan = { id, folder, root: realRoot, files: [], warnings: [] };
  if (mangle(realRoot).length > 200) {
    plan.warnings.push('project path is very long; Claude Code may shorten the folder name differently than carry does');
  }

  const byPart = new Map();
  for (const row of bundle.rows) {
    if (!byPart.has(row.p)) byPart.set(row.p, []);
    byPart.get(row.p).push(row);
  }

  for (const [rel, rows] of byPart) {
    const dest = rel === 'main.jsonl' ? path.join(folder, `${id}.jsonl`) : path.join(folder, id, rel.replace(/^side\//, ''));
    if (!path.resolve(dest).startsWith(path.resolve(folder) + path.sep)) throw new Error(`refusing path outside project folder: ${rel}`);
    const kind = rows[0].l !== undefined || rows[0].x !== undefined ? 'jsonl' : rows[0].t !== undefined ? 'text' : 'binary';
    let content;
    let stat;
    if (kind === 'jsonl') {
      const incoming = rows.map((r) => {
        const raw = r.l !== undefined ? JSON.stringify(mapStrings(r.l, text)) : back.fn(r.x);
        return { raw, rec: r.l !== undefined ? JSON.parse(raw) : null };
      });
      const local = fs.existsSync(dest) ? parseJsonl(fs.readFileSync(dest, 'utf8')) : [];
      const m = mergeEntries(local, incoming);
      content = m.lines.join('\n') + '\n';
      stat = { existed: local.length > 0, added: m.added, skipped: m.skipped };
    } else if (fs.existsSync(dest)) {
      stat = { existed: true, added: 0, skipped: 1 };
      content = null; // sidecar files are content-addressed by name; keep the local one
    } else {
      content = kind === 'text' ? back.fn(rows[0].t) : Buffer.from(rows[0].b, 'base64');
      stat = { existed: false, added: 1, skipped: 0 };
    }
    plan.files.push({ rel, dest, kind, ...stat });
    if (!dryRun && content !== null && (kind !== 'jsonl' || stat.added > 0 || !stat.existed)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.carry-tmp`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, dest);
    }
  }
  return plan;
}
