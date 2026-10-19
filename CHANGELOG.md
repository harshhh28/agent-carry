# Changelog

## Unreleased

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
