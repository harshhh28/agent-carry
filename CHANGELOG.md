# Changelog

Plugin, marketplace entry and package share one version number; `npm version` keeps them in step.

## 0.4.0

Finding sessions without knowing where they are stored. (0.3.0 was tagged but never published to npm.)

- `carry list --all` shows the most recent sessions across every folder, newest first, each tagged by where it was started (`[desktop]`, `[terminal]`, `[print mode]`) with the title the desktop app shows. Background-agent sessions (for example a memory plugin's observer) are hidden unless `--everything`.
- `carry list` options: `--limit N|all`, `--project DIR` (one folder), `--match TEXT` (title, folder or id), `--desktop` / `--terminal` (only sessions started there). Archived desktop sessions are marked; a desktop conversation with no project folder shows as "desktop scratch folder".
- `carry export` with no id offers a numbered picker that takes the same options.
- `/carry:share` uses the list; the plugin commands need CLI 0.4.0 or newer.

## 0.2.1

- Plugin commands check the CLI version first and say how to upgrade if it is older, instead of aborting on an unknown-command error.

## 0.2.0

- `carry import --desktop` adds the session to the Claude desktop app's Code tab (macOS). It targets the signed-in account (read from the app's log) and works for a freshly signed-in account by borrowing only app-level settings. Terminal colour codes in newly imported text are stripped, since the app shows them as literal characters.
- `export --latest` skips sessions with no prompts.
- Interactive plugin commands: `/carry:share` and `/carry:pickup` ask what they need (session, encryption, passphrase source, destination folder, desktop app and account). Installable with `/plugin install carry --marketplace harshhh28/agent-carry`.
- `export --generate-passphrase` (saved to `FILE.pass`, never printed); `carry bundles`; `carry desktop-dirs`.

## 0.1.1

- `agent-carry` works as a second command name for `carry`.
- README trimmed; plugin author set.

## 0.1.0

First release. Claude Code adapter.

- Export and import a session as a path-portable, redacted, merge-safe bundle (`carry export`, `carry import`, `carry inspect`, `carry list`).
- Folder sync (`carry push`, `carry pull`) with optional AES-256-GCM encryption.
- Plugin commands `/carry:share` and `/carry:pickup`, and optional session hooks.
- Redaction covers: private keys, Anthropic/OpenAI/GitHub/AWS/Google/Slack/Stripe keys, JWTs, Bearer tokens,
  passwords in URLs, `NAME=value` and `"name": "value"` secrets (including after ANSI colour codes, in lower case,
  and inside escaped JSON), and base64 blobs that decode to any of those.
- Credential-like text inside signed thinking blocks cannot be redacted, so export refuses unless you pass
  `--strip-thinking` (drop thinking blocks) or `--allow-thinking-secrets`. `carry push` skips such sessions.
- `carry --version`. Bundles larger than 1 GB are refused, and decompression is size-capped.
- A session id that exists in several project folders is resolved by the current folder or `--project`.
