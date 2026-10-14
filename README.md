# agent-carry

Move a coding-agent session to another machine, or another folder, and keep working.

**Agents:** Claude Code is supported today. Every bundle records which agent it came from (`agent` in the header),
so other agents can be added as adapters without changing the format; a build that doesn't know an agent refuses
its bundles with a clear error instead of guessing. Codex is the intended next adapter and is **not implemented yet**.

For Claude Code: it keeps each session in `~/.claude/projects/<folder>/<id>.jsonl`, where `<folder>` is the project's
absolute path with every non-alphanumeric character turned into `-`. The transcript itself is full of absolute
paths (about three quarters of the lines in a typical one). Copy the file to another machine and `--resume` can't
find it, and if you force it, every path in the history points at a machine that isn't there.

`carry` makes a session portable:

- **Path-portable.** Your project root, home directory and session-store path become tokens on export and are
  rewritten for the target machine on import. Object keys too: file-history snapshots are maps keyed by path.
- **Merge-safe.** Records have stable `uuid`s, so import is a union, not an overwrite. Importing twice changes
  nothing, and a session that continued on two machines becomes a two-branch history instead of a conflict.
  The local file is the source of truth: its lines are kept byte for byte.
- **Redacted.** Credential-shaped strings (cloud keys, tokens, JWTs, private keys, `*_SECRET=...`, URL passwords)
  are removed before anything is written. The export prints what it removed.
- **Complete.** Subagent transcripts and offloaded tool results travel with the session, and the references to
  them are rewritten.
- **Inspectable.** A bundle is newline-delimited JSON. `carry inspect` shows its header; `less` and `jq` show the rest.

```
npm i -g agent-carry

# on machine A, in the project folder
carry list
carry export --latest -o session.carry.gz

# on machine B, in the same project (wherever it lives)
carry import session.carry.gz
claude --resume <id>        # printed by import
```

As a Claude Code plugin (`plugin/`): `/carry:share` and `/carry:pickup` wrap the same two commands.

### Keep machines in sync through any shared folder

No server, account or key exchange: point both machines at a folder your existing sync tool already
replicates (Syncthing, Dropbox, iCloud, a git working tree, a network share).

```
export CARRY_PASSPHRASE='long passphrase'     # optional: encrypts everything written
carry push ~/Sync/carry                        # this project's sessions -> folder
carry pull ~/Sync/carry                        # other devices' sessions -> this machine
```

Layout: `<dir>/<project>/<session-id>/<device>.carry.gz` (or `.carry.enc`). Every file has exactly one writer,
so a sync tool never sees a conflict; `pull` unions the other devices' files into your local session. The
project is identified by its git remote, not its path, so `~/work/app` and `D:\code\app` find each other. Push
skips sessions that haven't changed, so the folder doesn't churn.

With the plugin installed, set `CARRY_SYNC_DIR` and the bundled hooks pull on session start and push on session
end. (Hooks are written to the plugin spec but I have not exercised them inside a live Claude Code yet.)

| command | |
|---|---|
| `carry list [--all]` | sessions for this folder (or every folder) |
| `carry export <id\|--latest> [-o FILE]` | build a bundle. `--no-redact`, `--redact-emails`, `--strip-thinking`, `--project-root DIR` |
| `carry inspect FILE` | header: parts, redaction counts, warnings |
| `carry import FILE [--project-root DIR] [--dry-run]` | write into the target folder's session store |
| `carry push DIR` / `carry pull DIR [--name P] [--dry-run] [--quiet]` | folder sync, described above |

Passphrase: `CARRY_PASSPHRASE` or `--passphrase-file`. AES-256-GCM with a scrypt-derived key (node:crypto), header
authenticated. Never pass a passphrase as an argument; it would land in shell history.

`--claude-home` and `--home` override `~/.claude` and the home directory, which is how the tests run two
machines in one process.

## Compared with ctxhop

[ctxhop](https://github.com/CCCCY-ci/ctxhop) is the larger, more mature tool and solves a wider problem. If you
want a continuously syncing, multi-device product with its own encrypted store, use it. Where the two differ
(from reading its README and adapter source, not from running it):

| | agent-carry | ctxhop |
|---|---|---|
| Scope | Claude Code sessions; share one, or sync a project through a folder | Claude Code + Codex, cross-agent switch, workspace and Git handoff, device authorisation, key rotation |
| Setup | none for a file; a shared folder for sync | `init` with an S3/R2/directory backend, passphrase, device invites |
| Runtime | Node, zero dependencies | Go binary, installers |
| Paths inside commands, prose and tool output | rewritten (boundary-aware); 0 leaks on 1,150 real sessions | left alone by design (only known path fields and bare paths are tokenised), so source paths and usernames stay in the history |
| Secrets inside transcript content | redacted before leaving the machine, with a report | not scanned; protected by encryption in transit and at rest |
| Sharing with someone else | a single inspectable file | designed for your own authorised devices |
| Inspectability | newline-delimited JSON, readable with `jq` | encrypted objects in a remote |
| Platforms | macOS, Linux | adds Windows |

So: carry is better when you want to *hand a session to someone*, keep secrets out of it, or sync with
nothing but a folder. ctxhop is better for an always-on personal sync across many devices and agents.

## What is verified

- `npm test`: 31 tests on synthetic two-machine setups: planted secrets and paths, merge, tampering, encryption, folder sync convergence.
- `npm run check:real` round-trips every session in your own `~/.claude` into a temp store under a different
  root, read-only on the real one. On the author's 1,150 sessions (58k records): no record lost, no dangling
  parent that wasn't already dangling, no source path left outside thinking blocks, re-import byte-identical.
  The same run redacted 200+ credential-shaped strings, so the problem the redactor solves is not hypothetical.

## What is not verified, or not handled

- **`claude --resume` on an imported session** is verified on one real session (900 KB, 418 paths rewritten,
  Claude Code 2.1.299): resumed from a folder it never ran in, it recalled its first request and reported the new
  working directory. That is one session on one version. Run `scripts/verify-resume.sh` on yours. The transcript
  format is internal and undocumented and can change; carry parses tolerantly and carries unknown lines through.
- **Thinking blocks are signed**, so they are carried verbatim: not path-rewritten, not redacted. The exporter
  counts credential-like strings inside them and warns; `--strip-thinking` removes them.
- **Redaction is pattern-based and best effort.** It will not find a password that looks like a sentence. A bundle
  is not encrypted. Don't commit one to a public repo, and read `carry inspect` before sharing.
- **Cowork / desktop**: not checked. If it stores sessions somewhere else, it needs its own adapter.
- **Push re-uploads sessions you pulled** (one file per device, merged on pull), so folder size grows with devices x sessions.
- **Windows paths** (drive letters, backslashes) are not handled. Folder names longer than ~200 characters may
  be shortened differently by Claude Code; import warns.
- **File-history backups** (`~/.claude/file-history`, used for rewind) are not carried.
- Relative traversal text like `../../Users/x` is tokenised for privacy, so it is cosmetically wrong after import.

## Verify resume yourself

```
node src/cli.js list --all                       # pick a session with real content
sh scripts/verify-resume.sh <session-id-prefix>
```

Exports the session, imports it into a throwaway folder, runs `claude -p --resume` there, and deletes both the
folder and the imported copy. The original is only read. PASS means the answer matches that session's first
request and names the new folder.

## Adding another agent

Everything Claude-specific is in four small places: how a project maps to a session folder (`src/paths.js`), how a
session and its sidecar files are found and read (`src/store.js`), how a transcript line is identified and
summarised (`src/transcript.js`), and the `AGENT` constant stamped into bundles (`src/bundle.js`). Path rewriting,
redaction, merging, encryption and folder sync work on parsed JSON and don't care which agent produced it.
An adapter for Codex would supply those four pieces for its own session format.

## Layout

```
src/paths.js      folder-key mangling, claude home
src/portable.js   path <-> token rewriting (boundary-aware, keys included, thinking skipped)
src/redact.js     secret patterns
src/merge.js      uuid union; local lines kept first
src/store.js      list / read a session and its sidecar files
src/bundle.js     build, read, import; integrity hash; path-traversal guard
src/crypto.js     passphrase encryption (scrypt + AES-256-GCM)
src/sync.js       push / pull over a shared folder
src/cli.js        carry
```

MIT.
