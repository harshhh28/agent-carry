---
description: Import a carry bundle into this folder so it can be resumed
argument-hint: <bundle-file> [--dry-run]
allowed-tools: Bash(carry import:*)
---

Import result:

!`carry import $ARGUMENTS 2>&1 || echo "carry is not installed: run npm i -g agent-carry"`

Tell the user the session was imported into this folder and that a running session cannot swap its own
history: they should exit and run the `claude --resume <id>` line printed above. If `--dry-run` was used,
say nothing was written.
