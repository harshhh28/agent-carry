---
description: Import a carry bundle into a folder (and optionally the Claude desktop app); asks which bundle, passphrase, and where
argument-hint: [bundle-file]
allowed-tools: Bash(carry:*), Bash(npx -y agent-carry@latest:*), Bash(ls:*), Bash(pwd), AskUserQuestion
---

carry CLI version (this command needs 0.4.0 or newer): !`carry --version 2>&1 || echo 'not installed'`

Bundle files nearby (this folder, ~/Downloads, ~/Desktop), newest first:

!`carry bundles 2>&1 || true`

Current folder: !`pwd`

Claude desktop app account folders (macOS only; an error here just means no desktop app):

!`carry desktop-dirs 2>&1 || true`

Arguments the user typed: $ARGUMENTS

**Step 0.** Look at the version line above. If it says "not installed" or shows anything older than 0.4.0, stop and say exactly this, with nothing else: "This command needs the carry CLI 0.4.0 or newer. Run `npm i -g agent-carry@latest`, then try again." (If that install still gives an older version, 0.4.0 has not been published to npm yet.) Any error text shown in the listings below comes from the same cause; do not try to work around it.

You are importing one session with the `carry` CLI.

Ask with the AskUserQuestion tool, one short question at a time, and skip any question the typed arguments already answer. If AskUserQuestion is not available, ask as a short numbered list in plain text and wait.

1. **Which bundle.** If the arguments name a file, use it. Otherwise offer up to four of the listed bundles (label: file name; description: date, size and what it holds). If none were found, ask for a path.
2. **Passphrase, only if the bundle is encrypted.** Options:
   - "Use the .pass file next to it": offer only if `ls <bundle>.pass` shows it exists.
   - "A passphrase file at another path": ask for the path, then `--passphrase-file PATH`.
   - "I'll type it here": warn that it is stored in this conversation's history. Pass it as `CARRY_PASSPHRASE='…' carry import …` and never repeat it back.
   (If `CARRY_PASSPHRASE` is already set in the environment, nothing is needed.) On a wrong-passphrase error, say so and ask once more.
3. **Which folder.** Claude Code finds a session by the folder you run `claude` in, so this should be the folder they will work in. Offer the current folder as "(Recommended)" or another path (create it with `mkdir -p` only if the user says so). Pass it as `--project-root`.
4. **Claude desktop app (only if account folders are listed above).** Ask "Also show it in the Claude desktop app's Code tab?" If yes and more than one folder is listed, ask which account: the one marked "* signed in" is "(Recommended)"; the rest are listed by their folder name and session count. Use `--desktop` for the signed-in account, or `--desktop-dir <folder>` for another one. If the import says it cannot tell which account is signed in, ask the user to choose from the list it printed.
5. **Run** `carry import <bundle> --project-root <folder> [--passphrase-file F] [--desktop | --desktop-dir D]` (add `--dry-run` if the user typed it, and say nothing was written).
6. **Report in at most five lines:** the session id, the folder it went into, and any warning. Then the next step: exit this session, then `cd <folder> && claude --resume <id>`; for the desktop app, restart it if the session does not appear and open the Code tab. A running session cannot swap its own history, so do not run `claude --resume` yourself.
