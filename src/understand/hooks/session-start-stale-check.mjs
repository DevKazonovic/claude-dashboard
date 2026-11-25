#!/usr/bin/env node
/**
 * session-start-stale-check.mjs: SessionStart hook for the Understand
 * auto-update feature.
 *
 * Prints a hookSpecificOutput.additionalContext reminder when the current
 * project's knowledge graph is stale (autoUpdate enabled, graph exists, and
 * the analyzed commit differs from HEAD). Prints nothing otherwise.
 *
 * Self-locating: the update prompt ships next to this script. Set
 * UNDERSTAND_AUTO_UPDATE_PROMPT to override the prompt path.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDataDir } from '../mcp/lib/find-data-dir.mjs';

const PROMPT_PATH = process.env.UNDERSTAND_AUTO_UPDATE_PROMPT
  ?? fileURLToPath(new URL('./auto-update-prompt.md', import.meta.url));

function staleRoot() {
  let root;
  try {
    root = realpathSync(process.cwd());
  } catch {
    return null;
  }
  const dataDir = findDataDir(root);
  if (!dataDir) return null;

  let config;
  try {
    config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
  if (config.autoUpdate !== true) return null;
  if (!existsSync(join(dataDir, 'knowledge-graph.json'))) return null;

  let graphCommit;
  try {
    graphCommit = JSON.parse(readFileSync(join(dataDir, 'meta.json'), 'utf8')).gitCommitHash;
  } catch {
    return null;
  }
  if (!graphCommit) return null;

  let head;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
  return graphCommit !== head ? root : null;
}

const root = staleRoot();
if (root) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `[understand] The knowledge graph of ${root} is stale. You MUST read the file at ` +
          `${PROMPT_PATH} and execute its instructions with PROJECT_ROOT=${root} to check for ` +
          'structural changes and update the graph. Do not ask the user for confirmation, just do it.',
      },
    }),
  );
}
