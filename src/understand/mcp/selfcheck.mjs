import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const home = realpathSync(mkdtempSync(join(tmpdir(), 'ua-mcp-selfcheck-')));
const env = { ...process.env, HOME: home };
const repo = join(home, 'repo');
const data = join(home, '.claude', 'understand', 'repo');
mkdirSync(repo);
mkdirSync(data, { recursive: true });
const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, env });
git('init', '-q');
git('commit', '-q', '--allow-empty', '-m', 'x');
const save = (file, value) => writeFileSync(join(data, file), JSON.stringify(value));
save('project.json', { key: 'repo', projectRoot: repo });
save('config.json', { autoUpdate: true });
save('meta.json', { gitCommitHash: 'abc' });
save('knowledge-graph.json', {
  version: '1.0.0',
  project: { name: 'repo', languages: ['javascript'], frameworks: [], description: 'd', analyzedAt: '2026-01-01T00:00:00.000Z', gitCommitHash: '' },
  nodes: [{ id: 'file:a.js', type: 'file', name: 'a.js', filePath: 'a.js', summary: 's', tags: [], complexity: 'simple' }],
  edges: [],
  layers: [],
  tour: [],
});

function rpc(messages) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, 'server.mjs')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('exit', () => resolve(Object.fromEntries(out.trim().split('\n').map((l) => JSON.parse(l)).map((m) => [m.id, m]))));
    child.stdin.end(messages.map((m) => (typeof m === 'string' ? m : JSON.stringify({ jsonrpc: '2.0', ...m }))).join('\n') + '\n');
  });
}

const hook = (name, cwd, input = '') =>
  execFileSync(process.execPath, [join(here, '..', 'hooks', name)], { cwd, env, input, encoding: 'utf8' });

try {
  const res = await rpc([
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'ping' },
    { id: 4, method: 'nope' },
    { id: 5, method: 'tools/call', params: { name: 'understand_status', arguments: { projectPath: repo } } },
    { id: 6, method: 'tools/call', params: { name: 'understand_status', arguments: { projectPath: home } } },
    { id: 7, method: 'tools/call', params: { name: 'understand_explain', arguments: { projectPath: repo, path: 'a.js' } } },
    '{oops',
  ]);
  assert.equal(Object.keys(res).length, 8);
  assert.equal(res[1].result.protocolVersion, '2024-11-05');
  assert.deepEqual(res[1].result.capabilities, { tools: {} });
  assert.equal(res[2].result.tools.length, 6);
  assert.deepEqual(res[3].result, {});
  assert.equal(res[4].error.code, -32601);
  assert.match(res[5].result.content[0].text, /# Understand Anything status: repo/);
  assert.equal(res[6].result.isError, true);
  assert.match(res[7].result.content[0].text, /# Deep Dive: a\.js/);
  assert.equal(res.null.error.code, -32700);

  assert.match(hook('session-start-stale-check.mjs', repo), /"hookEventName":"SessionStart"/);
  assert.equal(hook('session-start-stale-check.mjs', home), '');
  const commit = JSON.stringify({ tool_input: { command: 'git commit -m x' }, cwd: repo });
  assert.match(hook('post-tool-use-auto-update.mjs', repo, commit), /"hookEventName":"PostToolUse"/);
  assert.equal(hook('post-tool-use-auto-update.mjs', repo, JSON.stringify({ tool_input: { command: 'ls' }, cwd: repo })), '');
  save('config.json', { autoUpdate: false });
  assert.equal(hook('session-start-stale-check.mjs', repo), '');
  assert.equal(hook('post-tool-use-auto-update.mjs', repo, commit), '');
  console.log('mcp selfcheck ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
