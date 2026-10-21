# Changelog

## Unreleased

- `carry list --all` now shows the most recent sessions across every folder, newest first, with the title the desktop app shows and the folder; background-agent sessions (e.g. a memory plugin's observer) are hidden unless `--everything`. `carry export` with no id offers a numbered picker. `--limit N|all` shows more, `--project DIR` lists one folder, `--match TEXT` filters by title, folder or id, and `--desktop` / `--terminal` keep only sessions started in the desktop app or a terminal (every row is tagged; archived desktop sessions are marked; a desktop session with no project folder shows as "desktop scratch folder"). Nobody needs to know where sessions are stored. `/carry:share` uses it (plugin 0.3.0).

- Plugin 0.2.1 (released): commands check the CLI version first and say how to upgrade if it is older, instead of aborting on an unknown-command error.
- Plugin 0.2.0: `/carry:share` and `/carry:pickup` ask what they need (session, encryption, passphrase source, destination folder, desktop app and account) instead of expecting flags. Needs the CLI from this release.
- `export --generate-passphrase` (saved to `FILE.pass`, never printed); `carry bundles`; `carry desktop-dirs`.
- `--desktop` targets the signed-in account (read from the app's log) instead of any folder with sessions, and works for a freshly signed-in account by borrowing only app-level settings.

- Plugin installable from this repo: `/plugin install carry --marketplace harshhh28/agent-carry`.
- `export --latest` skips sessions with no prompts, so an opened-and-closed session no longer shadows the real one.
- `--desktop` strips terminal colour codes from newly imported text, which the app shows as literal characters.
- `carry import --desktop` adds the session to the Claude desktop app's Code tab (macOS).
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
