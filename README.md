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

# machine A (any folder): pick a session from a numbered list, with desktop-app titles
carry export -o session.carry.gz
# or: carry list --all   then   carry export <id> -o session.carry.gz
# more rows: --limit 50 | --limit all    one folder: --project DIR    search: --match word
# only desktop-app sessions: --desktop    only terminal ones: --terminal   (each row is tagged [desktop] / [terminal])

# machine B, in the same project (any path)
carry import session.carry.gz
claude --resume <id>          # printed by import
```

Encrypt a bundle with `CARRY_PASSPHRASE` or `--passphrase-file FILE` (AES-256-GCM, scrypt key). Never pass the
passphrase as an argument.

### Claude desktop app (Code tab)

The Code tab lists sessions from its own index, so an imported session resumes in a terminal but doesn't appear
there. Add `--desktop` to also write the index entry (macOS; the signed-in account is used):

```
carry import session.carry.gz --desktop
```

App settings are copied from that account's newest Code-tab session (or, for a new account, another account's), so use the Code tab at least once first.
Terminal colour codes in the imported text are stripped (the app would show them as literal `[38;2;…m`). Restart the desktop app if the session doesn't show.

The session is added to the account that is signed in (read from the app's log). If it can't tell, or you want another account, use `--desktop-dir DIR`; `carry desktop-dirs` lists the choices. A freshly signed-in account with no sessions borrows only app-level settings from another account, never its connectors or permissions. Cowork is a different store and isn't supported.

### Sync through a shared folder

Point both machines at a folder your sync tool already replicates (Dropbox, iCloud, Syncthing, a git tree).

```
carry push ~/Sync/carry       # this project's sessions -> folder
carry pull ~/Sync/carry       # other devices' sessions -> this machine
```

Projects are matched by git remote, not path. Each file has one writer, so there are no sync conflicts.

### Claude Code plugin

```
/plugin install carry --marketplace harshhh28/agent-carry
```

Needs the CLI (`npm i -g agent-carry`, 0.4.0 or newer). Works the same in the terminal and in the desktop app's Code tab. To update later: `npm i -g agent-carry@latest`, then `/plugin marketplace update agent-carry` and `/reload-plugins`.

- `/carry:share` asks which session, whether to encrypt (generate a passphrase, use your own file, or type one), and where to save.
- `/carry:pickup` lists bundles in this folder, ~/Downloads and ~/Desktop, then asks which one, the passphrase source, which folder to import into, and whether to add it to the desktop app (and which account).

Passphrases are never put on a command line. A generated one is saved beside the bundle as `FILE.pass` (mode 600) and never printed; a typed one is stored in that conversation's history, so use it only for throwaway passphrases. With `CARRY_SYNC_DIR` set, bundled hooks pull on session start and push on session end (hooks not yet exercised live).

## Commands

| command | |
|---|---|
| `carry list [--all] [--project DIR] [--desktop\|--terminal] [--match TEXT] [--limit N]` | sessions for this folder, or `--all`: recent sessions from every folder, each tagged by where it was started (`[desktop]`, `[terminal]`, `[print mode]`) with the desktop app's title. `--desktop` / `--terminal` keep only those. Background-agent sessions are hidden; `--everything` shows them |
| `carry export [id\|--latest] [-o FILE]` | with no id, pick from a numbered list (takes the same `--desktop`, `--terminal`, `--project`, `--match`). Also `--generate-passphrase`, `--no-redact`, `--redact-emails`, `--strip-thinking`, `--allow-thinking-secrets`, `--project-root DIR` |
| `carry inspect FILE` | header, parts, redaction counts |
| `carry import FILE [--project-root DIR] [--dry-run]` | write into the target folder's session store |
| `carry bundles` / `carry desktop-dirs` | bundle files nearby; desktop-app account folders |
| `carry push DIR` / `carry pull DIR` | folder sync (`--name`, `--dry-run`, `--quiet`) |

## Limits

- **Usage limit:** the CLI needs no Claude usage, so it still works when you have hit your limit; the plugin commands do not, because Claude has to run them.
- **Resume** is verified on one real session (Claude Code 2.1.299); the transcript format is internal and can change. Run `scripts/verify-resume.sh <id>` to check yours.
- **Thinking blocks are signed**, so they travel verbatim. If one contains a credential-like string, export refuses unless you pass `--strip-thinking` (resume with stripped thinking is untested) or `--allow-thinking-secrets`. `push` skips such sessions.
- **Redaction is best effort.** It misses passwords that read like sentences and letters-only lowercase `password=word`. Read `carry inspect` before sharing, and encrypt anything you send to someone else.
- `--desktop` writes the app's index format, which is internal and undocumented; it is tested against fixtures and a dry run on a real Code-tab folder, but not yet confirmed by resuming from the app itself.
- Not handled: Windows paths, Cowork, file-history (rewind) backups.
- `push` re-uploads pulled sessions, so a sync folder grows with devices × sessions.

## Development

```
npm test                  # 56 tests, synthetic two-machine setups
npm run check:real        # read-only round trip of your own ~/.claude sessions
```

To add an agent, supply its session-folder mapping (`src/paths.js`), session reader (`src/store.js`), transcript
record identity (`src/transcript.js`) and the `AGENT` constant (`src/bundle.js`). Path rewriting, redaction,
merging, encryption and sync are agent-independent. Codex is not implemented yet.

MIT
