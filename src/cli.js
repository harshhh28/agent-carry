#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { claudeHome, mangle, projectsDir, realpathOr } from './paths.js';
import { projectFolders, listSessions, findSession } from './store.js';
import { buildBundle, writeBundle, readBundle, importBundle } from './bundle.js';
import { parseJsonl, summarize } from './transcript.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isEncrypted } from './crypto.js';
import { pushProject, pullProject } from './sync.js';
import { registerDesktopSession, listDesktopDirs } from './desktop.js';
import { recentSessions, formatSession } from './browse.js';

const HELP = `carry (agent-carry): move coding-agent sessions between machines and folders. Supported agent: claude-code

  carry list    [--all [--limit N|all] [--everything]]   --all: recent sessions from every folder, with desktop-app titles
  carry export  [id|prefix|--latest] [-o FILE]   no id: pick from a numbered list of recent sessions [--project-root DIR]
                [--no-redact] [--redact-emails] [--strip-thinking | --allow-thinking-secrets]
                [--generate-passphrase]   encrypt with a random passphrase saved next to the bundle as FILE.pass
  carry bundles                                            bundle files in this folder, ~/Downloads and ~/Desktop
  carry inspect <bundle>
  carry import  <bundle> [--project-root DIR] [--dry-run] [--desktop [--desktop-dir DIR]]
  carry push    <dir> [--name PROJECT] [--quiet]     sync every session of this project to a shared folder
  carry desktop-dirs                                       desktop-app account folders (which one is signed in)
  carry pull    <dir> [--name PROJECT] [--dry-run] [--quiet]

Encryption (export, import, push, pull): set CARRY_PASSPHRASE or pass --passphrase-file FILE.

Global: --claude-home DIR (default $CLAUDE_CONFIG_DIR or ~/.claude), --home DIR
`;

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  const valued = new Set(['-o', '--out', '--project', '--project-root', '--claude-home', '--home', '--name', '--passphrase-file', '--desktop-dir', '--limit']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && a !== '-') {
      if (valued.has(a)) flags[a.replace(/^-+/, '')] = argv[++i];
      else flags[a.replace(/^-+/, '')] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

/** One line from stdin, or null at end of input. Synchronous so the rest of the CLI stays simple. */
function readLine() {
  const buf = Buffer.alloc(1);
  let line = '';
  let got = false;
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, 1, null);
    } catch (e) {
      if (e.code === 'EAGAIN') continue;
      if (e.code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    got = true;
    const c = buf.toString();
    if (c === '\n') return line.trim();
    line += c;
  }
  return got ? line.trim() : null;
}

function fail(msg) {
  process.stderr.write(`carry: ${msg}\n`);
  process.exit(1);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return process.stdout.write(`${pkg.version}\n`);
  }
  const { flags, pos } = parseArgs(rest);
  const home = flags['claude-home'] ? path.resolve(flags['claude-home']) : claudeHome();
  const userHome = flags.home ? path.resolve(flags.home) : os.homedir();
  const cwd = flags['project-root'] || flags.project || process.cwd();
  let passphrase = flags['passphrase-file'] ? fs.readFileSync(flags['passphrase-file'], 'utf8').replace(/\r?\n$/, '') : process.env.CARRY_PASSPHRASE || undefined;
  const say = (m) => flags.quiet || process.stdout.write(`${m}\n`);

  try {
    if (!cmd || cmd === 'help' || flags.help) return process.stdout.write(HELP);

    if (cmd === 'list') {
      if (flags.all) {
        const limit = flags.limit === 'all' ? Infinity : Number(flags.limit) || 20;
        const list = recentSessions({ home, userHome, limit, everything: !!flags.everything });
        for (const x of list) process.stdout.write(`${formatSession(x)}\n`);
        if (!list.length) process.stdout.write('no sessions found for any project\n');
        else if (list.length === limit) process.stdout.write(`(showing the ${limit} most recent; --limit N or --limit all for more)\n`);
        return;
      }
      const here = path.join(projectsDir(home), mangle(realpathOr(cwd)));
      const sessions = listSessions(here);
      for (const s of sessions) {
        const when = new Date(s.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
        process.stdout.write(`${s.id.slice(0, 8)}  ${when}  ${String(s.turns).padStart(3)} turns  ${s.title ?? '(untitled)'}\n`);
      }
      if (!sessions.length) process.stdout.write(`no sessions found for ${realpathOr(cwd)}; try: carry list --all\n`);
      return;
    }

    if (cmd === 'export') {
      const folders = flags.all || !flags.latest ? projectFolders(home) : [path.join(projectsDir(home), mangle(realpathOr(cwd)))];
      let target;
      if (flags.latest) {
        const here = path.join(projectsDir(home), mangle(realpathOr(cwd)));
        const all = listSessions(here);
        if (!all.length) fail(`no sessions for ${realpathOr(cwd)}`);
        // A session opened and closed without a prompt has nothing to carry; don't let it shadow the real one.
        const s = all.find((x) => x.turns > 0);
        if (!s) fail(`every session for ${realpathOr(cwd)} is empty (no prompts yet); run \`carry list\``);
        if (s !== all[0]) process.stderr.write(`carry: skipped ${all.indexOf(s)} newer empty session(s); exporting ${s.id.slice(0, 8)}\n`);
        target = { folder: here, id: s.id };
      } else if (!pos[0]) {
        // No id and no --latest: pick from recent sessions anywhere, so nobody needs to know where they are stored.
        const list = recentSessions({ home, userHome, limit: 10 });
        if (!list.length) fail('no sessions found; nothing to export');
        list.forEach((x, i) => process.stdout.write(`${formatSession(x, i + 1)}\n`));
        process.stdout.write('Export which one? [1] ');
        const ans = readLine();
        if (ans === null) fail('no session chosen; pass an id (see `carry list --all`) or --latest');
        const pick = list[(ans === '' ? 1 : Number(ans)) - 1];
        if (!pick) fail(`"${ans}" is not one of the numbers above`);
        target = { folder: pick.folder, id: pick.id };
      } else {
        // Same id can exist in several project folders (a session that was carried). Prefer the folder
        // named by --project, else the current one, and only then search everything.
        const scoped = path.join(projectsDir(home), mangle(realpathOr(flags.project || process.cwd())));
        try {
          target = findSession([scoped], pos[0]);
        } catch (e) {
          if (flags.project) throw e;
          target = findSession(folders, pos[0]);
        }
      }
      const entries = parseJsonl(fs.readFileSync(path.join(target.folder, `${target.id}.jsonl`), 'utf8'));
      const sum = summarize(entries);
      const root = flags['project-root'] ? realpathOr(flags['project-root']) : sum.dominantCwd;
      if (!root) fail('could not determine the project root from the transcript; pass --project-root');
      const { text, header } = buildBundle({
        folder: target.folder,
        id: target.id,
        where: { store: target.folder, root, home: userHome },
        redact: !flags['no-redact'],
        emails: !!flags['redact-emails'],
        stripThinking: !!flags['strip-thinking'],
        allowThinkingSecrets: !!flags['allow-thinking-secrets'],
      });
      let generated = null;
      if (flags['generate-passphrase']) {
        if (passphrase) fail('use either --generate-passphrase or a passphrase of your own, not both');
        generated = crypto.randomBytes(18).toString('base64url');
        passphrase = generated;
      }
      const out = flags.o || flags.out || `${target.id.slice(0, 8)}${passphrase ? '.carry.enc' : '.carry.gz'}`;
      writeBundle(out, text, { passphrase });
      if (generated) fs.writeFileSync(`${out}.pass`, `${generated}\n`, { mode: 0o600 });
      const red = Object.entries(header.redaction.counts || {}).map(([k, v]) => `${k}:${v}`).join(' ') || 'none found';
      process.stdout.write(
        `exported ${header.sessionId.slice(0, 8)} "${header.title ?? 'untitled'}" -> ${path.resolve(out)}\n` +
          `  parts: ${header.parts.length}   paths rewritten: ${header.pathsRewritten}\n` +
          `  redacted: ${header.redaction.enabled ? red : 'OFF'}   encrypted: ${passphrase ? 'yes' : 'no'}\n` +
          (generated ? `  passphrase saved to ${out}.pass (not printed); share it by a different channel than the bundle\n` : ''),
      );
      if (header.residualHomePaths > 0) {
        process.stderr.write(`  warning: ${header.residualHomePaths} other absolute home path(s) remain in the bundle (other users or tools). Review with \`carry inspect\`.\n`);
      }
      if (header.thinking.possibleSecrets > 0) {
        process.stderr.write(`  warning: ${header.thinking.possibleSecrets} credential-like string(s) in ${header.thinking.blocks} signed thinking block(s). These cannot be redacted without invalidating them; re-export with --strip-thinking.\n`);
      }
      if (header.skippedLarge.length) process.stderr.write(`  warning: ${header.skippedLarge.length} file(s) over 20MB were not included\n`);
      return;
    }

    if (cmd === 'bundles') {
      const seen = new Set();
      const found = [];
      for (const dir of [process.cwd(), path.join(userHome, 'Downloads'), path.join(userHome, 'Desktop')]) {
        let names = [];
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const n of names.filter((n) => /\.carry\.(gz|enc)$/.test(n))) {
          const file = path.join(dir, n);
          if (seen.has(file)) continue;
          seen.add(file);
          found.push({ file, st: fs.statSync(file) });
        }
      }
      found.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      for (const { file, st } of found.slice(0, 10)) {
        const enc = isEncrypted(fs.readFileSync(file).subarray(0, 64));
        let what = 'encrypted: needs its passphrase';
        if (!enc) {
          try {
            const { header } = readBundle(file, {});
            what = `"${header.title ?? 'untitled'}", ${header.turns} turn(s), session ${header.sessionId.slice(0, 8)}`;
          } catch {
            what = 'unreadable';
          }
        }
        process.stdout.write(`${file}\n    ${enc ? 'encrypted' : 'plain'}  ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}  ${(st.size / 1024).toFixed(1)} KB  ${what}\n`);
      }
      if (!found.length) process.stdout.write('no .carry.gz or .carry.enc files found here, in ~/Downloads or ~/Desktop\n');
      return;
    }

    if (cmd === 'desktop-dirs') {
      const list = listDesktopDirs({ home: userHome });
      for (const x of list) process.stdout.write(`${x.active ? '* signed in' : '  other    '}  ${x.entries} session${x.entries === 1 ? ' ' : 's'}  ${x.dir}\n`);
      if (!list.length) process.stdout.write('no desktop account folders found\n');
      return;
    }

    if (cmd === 'inspect') {
      if (!pos[0]) fail('inspect needs a bundle file');
      const { header } = readBundle(pos[0], { passphrase });
      process.stdout.write(JSON.stringify(header, null, 2) + '\n');
      return;
    }

    if (cmd === 'import') {
      if (!pos[0]) fail('import needs a bundle file');
      const bundle = readBundle(pos[0], { passphrase });
      const plan = importBundle({ bundle, claudeHome: home, root: cwd, home: userHome, dryRun: !!flags['dry-run'], stripAnsi: !!(flags.desktop || flags['desktop-dir']) });
      process.stdout.write(`${flags['dry-run'] ? 'would import' : 'imported'} ${plan.id.slice(0, 8)} into ${plan.folder}\n`);
      for (const f of plan.files.filter((f) => f.kind === 'jsonl')) {
        process.stdout.write(`  ${f.rel}: +${f.added} new, ${f.skipped} already present\n`);
      }
      const side = plan.files.filter((f) => f.kind !== 'jsonl');
      if (side.length) process.stdout.write(`  sidecar files: ${side.filter((f) => f.added).length} new, ${side.filter((f) => !f.added).length} kept\n`);
      for (const w of plan.warnings) process.stderr.write(`  warning: ${w}\n`);
      if (flags.desktop || flags['desktop-dir']) {
        try {
          const main = plan.files.find((f) => f.rel === 'main.jsonl');
          const d = registerDesktopSession({ id: plan.id, root: plan.root, mainFile: main.dest, home: userHome, dir: flags['desktop-dir'], dryRun: !!flags['dry-run'] });
          const verb = { registered: 'added to the desktop Code tab', exists: 'already in the desktop Code tab', 'would-register': 'would be added to the desktop Code tab' }[d.status];
          process.stdout.write(`  ${verb} (${d.file}); restart the Claude desktop app if it does not appear\n`);
          process.stdout.write(`  desktop folder: ${d.dir}\n`);
          if (d.status === 'exists' && d.entryCwd && d.entryCwd !== plan.root) process.stdout.write(`  note: that Code-tab entry points at ${d.entryCwd}, not ${plan.root}\n`);
          process.stdout.write(`  chosen as: ${d.how}${d.borrowed ? '; this account has no sessions yet, so app settings were borrowed from another account' : ''}\n`);
        } catch (e) {
          process.stderr.write(`  desktop: ${e.message}\n  the session itself was imported and resumes from a terminal\n`);
        }
      }
      if (!flags['dry-run']) process.stdout.write(`\nresume with:\n  cd ${plan.root} && claude --resume ${plan.id}\n`);
      return;
    }

    if (cmd === 'push' || cmd === 'pull') {
      if (!pos[0]) fail(`${cmd} needs a shared folder, e.g. carry ${cmd} ~/Sync/carry`);
      const dir = path.resolve(pos[0]);
      const common = { dir, claudeHome: home, root: cwd, userHome, passphrase, name: flags.name, log: say };
      if (cmd === 'push') {
        const r = pushProject(common);
        if (r.skipped.length) process.stderr.write(`  ${r.skipped.length} session(s) skipped: credential-like text in thinking blocks\n`);
        say(`push ${r.key}: ${r.pushed} written, ${r.unchanged} unchanged (device ${r.device}${passphrase ? ', encrypted' : ''})`);
      } else {
        const r = pullProject({ ...common, dryRun: !!flags['dry-run'] });
        say(`pull ${r.key}: ${r.imported} session(s) updated, ${r.upToDate} up to date`);
        for (const e of r.errors) process.stderr.write(`  error: ${e}\n`);
        if (r.errors.length) process.exitCode = 1;
      }
      return;
    }

    fail(`unknown command "${cmd}"\n\n${HELP}`);
  } catch (e) {
    fail(e.message);
  }
}

main();
