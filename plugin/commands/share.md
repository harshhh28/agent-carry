---
description: Export a session as a portable, redacted bundle; asks which session, whether to encrypt, and where to save
argument-hint: [optional carry export flags, e.g. -o FILE --strip-thinking]
allowed-tools: Bash(carry:*), Bash(npx -y agent-carry@latest:*), AskUserQuestion
---

carry CLI version (this command needs 0.2.0 or newer): !`carry --version 2>&1 || echo 'not installed'`

Recent sessions from every folder, newest first, including ones started in the Claude desktop app (the top one is usually this conversation):

!`carry list --all --limit 8 2>&1 || true`

Current folder: !`pwd`

Arguments the user typed: $ARGUMENTS

**Step 0.** Look at the version line above. If it says "not installed" or shows anything older than 0.2.0, stop and say exactly this, with nothing else: "This command needs the carry CLI 0.2.0 or newer. Run `npm i -g agent-carry@latest`, then try again." (If that install still gives an older version, 0.2.0 has not been published to npm yet.) Any error text shown in the listings below comes from the same cause; do not try to work around it.

You are exporting one session with the `carry` CLI.

Ask with the AskUserQuestion tool, one short question at a time, and skip any question the typed arguments already answer. If AskUserQuestion is not available, ask the same questions as a short numbered list in plain text and wait for the reply.

1. **Which session.** The user may not know where sessions are stored, so offer them from the list above, never ask for a folder. If the arguments name a session or `--latest`, use it. Otherwise ask, offering the newest first as "(Recommended)" and up to three more; label each with its title, and describe it with its folder, date, turn count and `[desktop app]` when shown. If none fit, offer "show more" (`carry list --all --limit 20`). Export by id: `carry export <id>` works from any folder.
2. **Encrypt?** Options:
   - "No, plain file": readable by anyone who gets it (secrets are still redacted).
   - "Yes, generate a passphrase (Recommended when sending it to someone)": run with `--generate-passphrase`.
   - "Yes, use my passphrase file": ask for the path, then use `--passphrase-file PATH`.
   - "Yes, I'll type one here": warn that whatever is typed is stored in this conversation's history, so use only a throwaway passphrase. Take it from a follow-up question and pass it as `CARRY_PASSPHRASE='…' carry export …`. Never repeat it back, never put it in a file name.
3. **Where to save.** Options: this folder (default), Desktop, or another path. Name the file `<first 8 chars of the id>.carry.gz`, or `.carry.enc` when encrypting, and pass it with `-o`.
4. **Run** `carry export <id> -o <file> [flags]` (with `--project-root` only if the user asked). If it refuses because signed thinking blocks contain credential-like strings, ask: "Drop thinking blocks (Recommended)" or "Keep them as they are (the strings stay in the file)", then re-run with `--strip-thinking` or `--allow-thinking-secrets`.
5. **Report in at most five lines:** the file path, how many secrets were redacted, whether it is encrypted, and any warning. If a passphrase was generated, say it is saved in `<file>.pass` (mode 600) and must be sent by a different channel than the bundle; do not print it. Tell them the other side runs `/carry:pickup` or `carry import <file>`.

Never open or print the bundle's contents, and never put a passphrase on a command line other than as `CARRY_PASSPHRASE` above.
