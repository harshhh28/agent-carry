---
description: Export a session as a portable, redacted bundle; asks which session, whether to encrypt, and where to save
argument-hint: [optional carry export flags, e.g. -o FILE --strip-thinking]
allowed-tools: Bash(carry:*), Bash(npx -y agent-carry@latest:*), AskUserQuestion
---

Sessions in this folder, newest first (the top one is usually this conversation):

!`carry list 2>&1 || npx -y agent-carry@latest list 2>&1`

Arguments the user typed: $ARGUMENTS

You are exporting one session with the `carry` CLI. If `carry` was not found above, use `npx -y agent-carry@latest` in its place; if that also fails, tell the user to run `npm i -g agent-carry` and stop. If a command below says it is unknown, the CLI is old: tell the user to run `npm i -g agent-carry@latest`.

Ask with the AskUserQuestion tool, one short question at a time, and skip any question the typed arguments already answer. If AskUserQuestion is not available, ask the same questions as a short numbered list in plain text and wait for the reply.

1. **Which session.** Ignore rows with 0 turns. If only one has turns, use it without asking. Otherwise ask, offering the newest first as "(Recommended)" and up to three more; label each with its id prefix and title, and describe it with its date and turn count.
2. **Encrypt?** Options:
   - "No, plain file": readable by anyone who gets it (secrets are still redacted).
   - "Yes, generate a passphrase (Recommended when sending it to someone)": run with `--generate-passphrase`.
   - "Yes, use my passphrase file": ask for the path, then use `--passphrase-file PATH`.
   - "Yes, I'll type one here": warn that whatever is typed is stored in this conversation's history, so use only a throwaway passphrase. Take it from a follow-up question and pass it as `CARRY_PASSPHRASE='…' carry export …`. Never repeat it back, never put it in a file name.
3. **Where to save.** Options: this folder (default), Desktop, or another path. Name the file `<first 8 chars of the id>.carry.gz`, or `.carry.enc` when encrypting, and pass it with `-o`.
4. **Run** `carry export <id> -o <file> [flags]` (with `--project-root` only if the user asked). If it refuses because signed thinking blocks contain credential-like strings, ask: "Drop thinking blocks (Recommended)" or "Keep them as they are (the strings stay in the file)", then re-run with `--strip-thinking` or `--allow-thinking-secrets`.
5. **Report in at most five lines:** the file path, how many secrets were redacted, whether it is encrypted, and any warning. If a passphrase was generated, say it is saved in `<file>.pass` (mode 600) and must be sent by a different channel than the bundle; do not print it. Tell them the other side runs `/carry:pickup` or `carry import <file>`.

Never open or print the bundle's contents, and never put a passphrase on a command line other than as `CARRY_PASSPHRASE` above.
