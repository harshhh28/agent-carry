import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Claude Code stores a project's sessions in a folder named after the project's
 * working directory with every non-alphanumeric character replaced by '-'.
 * The mapping is lossy (`/a/b-c` and `/a/b/c` collide), so it can only be
 * computed forward, never inverted. That is why a session cannot simply be
 * copied to another machine: the folder key depends on the absolute path.
 */
export const mangle = (absPath) => absPath.replace(/[^A-Za-z0-9]/g, '-');

export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export const projectsDir = (home) => path.join(home, 'projects');

export function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
