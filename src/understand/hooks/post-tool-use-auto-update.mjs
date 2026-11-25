#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDataDir } from '../mcp/lib/find-data-dir.mjs';

const PROMPT_PATH = fileURLToPath(new URL('./auto-update-prompt.md', import.meta.url));

const COMMIT_COMMAND = /git\s+(commit|merge|cherry-pick|rebase)/;

function autoUpdateEnabled(dataDir) {
  try {
    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
    return config.autoUpdate === true;
  } catch {
    return false;
  }
}

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }

  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || !COMMIT_COMMAND.test(command)) return;

  let root;
  try {
    root = realpathSync(typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
  } catch {
    return;
  }
  const dataDir = findDataDir(root);
  if (!dataDir || !autoUpdateEnabled(dataDir)) return;
  if (!existsSync(join(dataDir, 'knowledge-graph.json'))) return;

  const additionalContext =
    `[understand] Commit detected in ${root} with auto-update enabled. ` +
    `You MUST read the file at ${PROMPT_PATH} and execute its instructions with ` +
    `PROJECT_ROOT=${root} to incrementally update the knowledge graph. ` +
    'Do not ask the user for confirmation, just do it.';

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext,
      },
    }),
  );
}

await main();
