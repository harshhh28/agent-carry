#!/usr/bin/env node
// Keeps one version number everywhere. Runs from the npm "version" lifecycle, i.e. after `npm version` has
// bumped package.json and before it commits, so the changes below land in the same release commit.
//   package.json  ->  plugin/.claude-plugin/plugin.json, .claude-plugin/marketplace.json (the carry entry)
//   CHANGELOG.md  ->  "## Unreleased" becomes "## <version>"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(root, f), s);
const version = JSON.parse(read('package.json')).version;

const plugin = JSON.parse(read('plugin/.claude-plugin/plugin.json'));
plugin.version = version;
write('plugin/.claude-plugin/plugin.json', JSON.stringify(plugin, null, 2) + '\n');

const market = JSON.parse(read('.claude-plugin/marketplace.json'));
for (const p of market.plugins) if (p.name === plugin.name) p.version = version;
write('.claude-plugin/marketplace.json', JSON.stringify(market, null, 2) + '\n');

const log = read('CHANGELOG.md');
if (/^## Unreleased\s*$/m.test(log)) write('CHANGELOG.md', log.replace(/^## Unreleased\s*$/m, `## ${version}`));
else if (!new RegExp(`^## ${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(log)) console.warn(`sync-version: CHANGELOG.md has no "## Unreleased" or "## ${version}" section`);

console.log(`sync-version: plugin, marketplace and changelog now at ${version}`);
