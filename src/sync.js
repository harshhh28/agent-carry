import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mangle, projectsDir, realpathOr } from './paths.js';
import { listSessions } from './store.js';
import { buildBundle, writeBundle, readBundle, importBundle } from './bundle.js';

/**
 * Folder sync. `push` and `pull` turn any shared folder (Syncthing, Dropbox,
 * iCloud, a git working tree, a network share) into a session sync backend:
 *
 *   <dir>/<project>/<session-id>/<device-id>.carry.gz[.enc]
 *
 * Every file has exactly one writer (its device), so the sync tool never sees
 * a write conflict. `pull` unions every other device's file into the local
 * session, which is safe to repeat because merging is idempotent.
 */

export function configDir(env = process.env) {
  if (env.CARRY_HOME) return env.CARRY_HOME;
  if (process.platform === 'win32') return path.join(env.APPDATA || os.homedir(), 'agent-carry');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agent-carry');
}

const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, f);
}

export function deviceInfo(cfg) {
  const f = path.join(cfg, 'device.json');
  let d = readJson(f, null);
  if (!d?.id) {
    const host = os.hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'device';
    d = { id: `${host}-${crypto.randomBytes(3).toString('hex')}` };
    writeJson(f, d);
  }
  return d;
}

/**
 * The same project lives at different paths on different machines, so its
 * identity can't be its path. Prefer the git remote; fall back to the folder name.
 */
export function projectKey(root, override) {
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (override) return clean(override);
  const base = clean(path.basename(root)) || 'project';
  try {
    const url = execFileSync('git', ['-C', root, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (url) {
      const norm = url.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/:/g, '/').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
      return `${base}-${crypto.createHash('sha256').update(norm).digest('hex').slice(0, 8)}`;
    }
  } catch {
    /* not a git repo */
  }
  return base;
}

const ext = (passphrase) => (passphrase ? '.carry.enc' : '.carry.gz');

export function pushProject({ dir, claudeHome, root, userHome, passphrase, name, cfg = configDir(), log = () => {} }) {
  const realRoot = realpathOr(root);
  const folder = path.join(projectsDir(claudeHome), mangle(realRoot));
  const key = projectKey(realRoot, name);
  const dev = deviceInfo(cfg);
  const out = { key, device: dev.id, pushed: 0, unchanged: 0 };
  for (const s of listSessions(folder)) {
    const target = path.join(dir, key, s.id, `${dev.id}${ext(passphrase)}`);
    const { text, header } = buildBundle({ folder, id: s.id, where: { store: folder, root: realRoot, home: userHome } });
    if (fs.existsSync(target)) {
      try {
        if (readBundle(target, { passphrase }).header.bodySha256 === header.bodySha256) {
          out.unchanged++;
          continue;
        }
      } catch {
        /* unreadable old file: overwrite it */
      }
    }
    writeBundle(target, text, { passphrase });
    out.pushed++;
    log(`pushed ${s.id.slice(0, 8)} ${s.title ?? ''}`);
  }
  return out;
}

export function pullProject({ dir, claudeHome, root, userHome, passphrase, name, dryRun = false, cfg = configDir(), log = () => {} }) {
  const realRoot = realpathOr(root);
  const key = projectKey(realRoot, name);
  const dev = deviceInfo(cfg);
  const stateFile = path.join(cfg, 'pulled.json');
  const state = readJson(stateFile, {});
  const out = { key, imported: 0, upToDate: 0, sessions: 0, errors: [] };
  const projDir = path.join(dir, key);
  if (!fs.existsSync(projDir)) return out;
  for (const id of fs.readdirSync(projDir)) {
    const sdir = path.join(projDir, id);
    if (!fs.statSync(sdir).isDirectory()) continue;
    for (const f of fs.readdirSync(sdir)) {
      if (!/\.carry\.(gz|enc)$/.test(f) || f.startsWith(`${dev.id}.`)) continue;
      const file = path.join(sdir, f);
      const st = fs.statSync(file);
      const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
      if (state[file] === sig) {
        out.upToDate++;
        continue;
      }
      try {
        const bundle = readBundle(file, { passphrase });
        const plan = importBundle({ bundle, claudeHome, root: realRoot, home: userHome, dryRun });
        const added = plan.files.filter((x) => x.kind === 'jsonl').reduce((n, x) => n + x.added, 0);
        if (!dryRun) state[file] = sig;
        out.imported += added > 0 ? 1 : 0;
        out.upToDate += added > 0 ? 0 : 1;
        out.sessions++;
        if (added > 0) log(`pulled ${id.slice(0, 8)} from ${f.split('.')[0]} (+${added} records)`);
      } catch (e) {
        out.errors.push(`${id.slice(0, 8)}/${f}: ${e.message}`);
      }
    }
  }
  if (!dryRun) writeJson(stateFile, state);
  return out;
}
