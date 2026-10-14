---
description: Export this project's latest session as a portable, redacted carry bundle
argument-hint: [-o FILE] [--strip-thinking] [--redact-emails]
allowed-tools: Bash(carry export:*)
---

Export result (this runs the `carry` CLI from `npm i -g agent-carry`):

!`carry export --latest $ARGUMENTS 2>&1 || echo "carry is not installed: run npm i -g agent-carry"`

Report in at most three lines: the file that was written, how many secrets were redacted, and any warning above.
If there is a warning about credential-like strings in thinking blocks, tell the user to re-run `/carry:share --strip-thinking`.
Do not open or print the bundle's contents.
