import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mangle } from '../src/paths.js';

export const tmp = (p = 'carry-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

export const SECRETS = {
  // Built at runtime so no credential-shaped literal sits in the source (GitHub push protection).
  anthropic: 'sk-ant-' + 'api03-' + 'A'.repeat(32),
  github: 'ghp_' + 'a1B2c3D4e5'.repeat(4),
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  envLine: 'STRIPE_SECRET_KEY=whsec_notsosecret12345',
  bearer: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
  dburl: 'postgres://admin:hunter2hunter2@db.internal:5432/app',
};

/** Build a fake machine: <root>/.claude with one session, a subagent file and a tool-result sidecar. */
export function fakeMachine({ userHome, projectRoot, id = '11111111-2222-3333-4444-555555555555' }) {
  const claude = path.join(userHome, '.claude');
  const folder = path.join(claude, 'projects', mangle(projectRoot));
  fs.mkdirSync(path.join(folder, id, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(folder, id, 'tool-results'), { recursive: true });
  const toolFile = path.join(folder, id, 'tool-results', 'big.txt');
  fs.writeFileSync(toolFile, `output from ${projectRoot}/src/app.js\n${SECRETS.envLine}\n`);

  const base = { sessionId: id, cwd: projectRoot, version: '2.1.299', entrypoint: 'cli', gitBranch: 'main' };
  const recs = [
    { type: 'mode', mode: 'default', sessionId: id },
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-10-14T08:00:00Z', message: { role: 'user', content: `read ${projectRoot}/src/app.js and ${projectRoot}-other/x.js` } },
    {
      ...base,
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      timestamp: '2026-10-14T08:00:05Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: `I should look in ${projectRoot}/src`, signature: 'SIG==' },
          { type: 'text', text: `Looking at ${userHome}/.zshrc too. key ${SECRETS.anthropic}` },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `cat ${projectRoot}/.env; echo ${SECRETS.github}; ${SECRETS.aws}` } },
        ],
      },
    },
    {
      ...base,
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      timestamp: '2026-10-14T08:00:09Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `${SECRETS.envLine}\n${SECRETS.bearer}\n${SECRETS.dburl}\nsaved to ${toolFile}` }] },
    },
    { type: 'ai-title', aiTitle: 'Fix the app', sessionId: id },
  ];
  const main = path.join(folder, `${id}.jsonl`);
  fs.writeFileSync(main, recs.map((r) => JSON.stringify(r)).join('\n') + '\nthis line is not json\n');
  fs.writeFileSync(
    path.join(folder, id, 'subagents', 'agent-x.jsonl'),
    JSON.stringify({ ...base, type: 'user', uuid: 's1', parentUuid: null, isSidechain: true, message: { role: 'user', content: `explore ${projectRoot}` } }) + '\n',
  );
  return { claude, folder, id, main, toolFile };
}

export const readLines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
