import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

test('package, plugin and marketplace entry carry the same version, and the changelog has a section for it', () => {
  const v = json('package.json').version;
  assert.equal(json('plugin/.claude-plugin/plugin.json').version, v);
  assert.equal(json('.claude-plugin/marketplace.json').plugins.find((p) => p.name === 'carry').version, v);
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## ${v.replace(/\./g, '\\.')}\\s*$`, 'm'));
});

test('sync-version brings plugin, marketplace and changelog to the package version', () => {
  const dir = tmp('carry-ver-');
  for (const f of ['package.json', 'plugin/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'CHANGELOG.md', 'scripts/sync-version.js']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(dir, f));
  }
  const pkg = path.join(dir, 'package.json');
  fs.writeFileSync(pkg, JSON.stringify({ ...json('package.json'), version: '9.8.7' }));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- something\n\n## 0.1.0\n');
  execFileSync('node', [path.join(dir, 'scripts', 'sync-version.js')], { encoding: 'utf8' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'plugin/.claude-plugin/plugin.json'), 'utf8')).version, '9.8.7');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/marketplace.json'), 'utf8')).plugins[0].version, '9.8.7');
  const log = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(log, /^## 9\.8\.7$/m);
  assert.ok(!log.includes('## Unreleased'));
});
