# agent-carry

Move a coding-agent session to another machine or folder and keep working. Supports Claude Code today.

Claude Code stores sessions per absolute project path, and the transcripts are full of absolute paths, so a
copied session can't be resumed elsewhere. `carry` fixes that:

- **Path-portable:** project, home and store paths become tokens on export and are rewritten on import.
- **Merge-safe:** import is a union by record `uuid`. Importing twice changes nothing; a session continued on two machines becomes a two-branch history.
- **Redacted:** credential-shaped strings (cloud keys, tokens, JWTs, private keys, `*_SECRET=...`, URL passwords) are removed on export, with a report.
- **Complete:** subagent transcripts and tool results travel with the session.
- **Inspectable:** a bundle is newline-delimited JSON (gzipped).

## Usage

```
npm i -g agent-carry          # installs `carry` (also available as `agent-carry`)

# machine A, in the project folder
carry list
carry export --latest -o session.carry.gz

# machine B, in the same project (any path)
carry import session.carry.gz
claude --resume <id>          # printed by import
```

Encrypt a bundle with `CARRY_PASSPHRASE` or `--passphrase-file FILE` (AES-256-GCM, scrypt key). Never pass the
passphrase as an argument.

### Claude desktop app (Code tab)

The Code tab lists sessions from its own index, so an imported session resumes in a terminal but doesn't appear
there. Add `--desktop` to also write the index entry (macOS; with several accounts it uses the most recently used one and prints which; `--desktop-dir DIR` overrides):

```
carry import session.carry.gz --desktop
```

App settings are copied from your newest existing Code-tab session, so use the Code tab at least once first.
Terminal colour codes in the imported text are stripped (the app would show them as literal `[38;2;…m`). Restart the desktop app if the session doesn't show. Cowork is a different store and isn't supported.

### Sync through a shared folder

Point both machines at a folder your sync tool already replicates (Dropbox, iCloud, Syncthing, a git tree).

```
carry push ~/Sync/carry       # this project's sessions -> folder
carry pull ~/Sync/carry       # other devices' sessions -> this machine
```

Projects are matched by git remote, not path. Each file has one writer, so there are no sync conflicts.

### Claude Code plugin

`plugin/` adds `/carry:share` and `/carry:pickup`. With `CARRY_SYNC_DIR` set, bundled hooks pull on session
start and push on session end (hooks not yet exercised in a live Claude Code).

## Commands

| command | |
|---|---|
| `carry list [--all]` | sessions for this folder, or all |
| `carry export <id\|--latest> [-o FILE]` | `--no-redact`, `--redact-emails`, `--strip-thinking`, `--allow-thinking-secrets`, `--project-root DIR` |
| `carry inspect FILE` | header, parts, redaction counts |
| `carry import FILE [--project-root DIR] [--dry-run]` | write into the target folder's session store |
| `carry push DIR` / `carry pull DIR` | folder sync (`--name`, `--dry-run`, `--quiet`) |

## Limits

- **Resume** is verified on one real session (Claude Code 2.1.299); the transcript format is internal and can change. Run `scripts/verify-resume.sh <id>` to check yours.
- **Thinking blocks are signed**, so they travel verbatim. If one contains a credential-like string, export refuses unless you pass `--strip-thinking` (resume with stripped thinking is untested) or `--allow-thinking-secrets`. `push` skips such sessions.
- **Redaction is best effort.** It misses passwords that read like sentences and letters-only lowercase `password=word`. Read `carry inspect` before sharing, and encrypt anything you send to someone else.
- `--desktop` writes the app's index format, which is internal and undocumented; it is tested against fixtures and a dry run on a real Code-tab folder, but not yet confirmed by resuming from the app itself.
- Not handled: Windows paths, Cowork, file-history (rewind) backups.
- `push` re-uploads pulled sessions, so a sync folder grows with devices × sessions.

## Development

```
npm test                  # 45 tests, synthetic two-machine setups
npm run check:real        # read-only round trip of your own ~/.claude sessions
```

To add an agent, supply its session-folder mapping (`src/paths.js`), session reader (`src/store.js`), transcript
record identity (`src/transcript.js`) and the `AGENT` constant (`src/bundle.js`). Path rewriting, redaction,
merging, encryption and sync are agent-independent. Codex is not implemented yet.

MIT
