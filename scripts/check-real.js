#!/usr/bin/env node
// Round-trips every real local session through export -> import into a temp
// Claude home under a different root, then checks invariants. Read-only on the
// real store; prints counts only, never transcript content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeHome, mangle } from '../src/paths.js';
import { projectFolders, listSessions } from '../src/store.js';
import { buildBundle, importBundle, readBundle, writeBundle } from '../src/bundle.js';
import { parseJsonl } from '../src/transcript.js';

const home = claudeHome();
const userHome = os.homedir();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carry-real-')));
const targetHome = path.join(tmp, 'home');
const targetRoot = path.join(tmp, 'elsewhere', 'proj');
fs.mkdirSync(targetRoot, { recursive: true });

const strip = (rec) => {
  const c = rec?.message?.content;
  return Array.isArray(c) ? { ...rec, message: { ...rec.message, content: c.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') } } : rec;
};
const stats = { sessions: 0, ok: 0, failed: [], records: 0, uuidLoss: 0, orphanDelta: 0, leaks: 0, idempotentFail: 0, flagged: [], redactions: {}, thinkingSecrets: 0, bytes: 0 };

for (const folder of projectFolders(home)) {
  for (const s of listSessions(folder)) {
    stats.sessions++;
    try {
      const root = s.dominantCwd;
      if (!root) { stats.failed.push(`${s.id.slice(0, 8)}: no cwd`); continue; }
      const { text, header } = buildBundle({ folder, id: s.id, where: { store: folder, root, home: userHome } });
      stats.bytes += text.length;
      for (const [k, v] of Object.entries(header.redaction.counts)) stats.redactions[k] = (stats.redactions[k] || 0) + v;
      stats.thinkingSecrets += header.thinking.possibleSecrets;
      const file = path.join(tmp, `${s.id}.carry.gz`);
      writeBundle(file, text);
      const run = () => importBundle({ bundle: readBundle(file), claudeHome: targetHome, root: targetRoot, home: path.join(tmp, 'userhome') });
      const plan = run();
      const dest = path.join(plan.folder, `${s.id}.jsonl`);
      const src = parseJsonl(fs.readFileSync(s.file, 'utf8'));
      const out = parseJsonl(fs.readFileSync(dest, 'utf8'));
      stats.records += src.length;
      const ids = (es) => new Set(es.filter((e) => e.rec?.uuid).map((e) => e.rec.uuid));
      const si = ids(src), oi = ids(out);
      stats.uuidLoss += [...si].filter((u) => !oi.has(u)).length;
      const orphans = (es, set) => es.filter((e) => e.rec?.parentUuid && !set.has(e.rec.parentUuid)).length;
      stats.orphanDelta += Math.abs(orphans(src, si) - orphans(out, oi));
      if (out.length < src.length) { stats.uuidLoss++; stats.flagged.push(`${s.id.slice(0, 8)} lost-records age=${Math.round((Date.now() - s.mtimeMs) / 1000)}s`); }
      const visible = out.map((e) => (e.rec ? JSON.stringify(strip(e.rec)) : e.raw)).join('\n');
      if (visible.includes(root) || visible.includes(userHome)) { stats.leaks++; stats.flagged.push(`${s.id.slice(0, 8)} leak age=${Math.round((Date.now() - s.mtimeMs) / 1000)}s`); }
      const before = fs.readFileSync(dest, 'utf8');
      run();
      if (fs.readFileSync(dest, 'utf8') !== before) stats.idempotentFail++;
      stats.ok++;
    } catch (e) {
      stats.failed.push(`${s.id.slice(0, 8)}: ${e.message}`);
    }
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ ...stats, bundleMB: +(stats.bytes / 1e6).toFixed(1), bytes: undefined }, null, 2));
process.exit(stats.failed.length || stats.uuidLoss || stats.orphanDelta || stats.idempotentFail ? 1 : 0);
