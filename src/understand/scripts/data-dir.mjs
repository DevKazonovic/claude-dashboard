#!/usr/bin/env node
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { resolveUaDir } from '../core/index.js';
import { parseFileKey } from '../core/figma/index.js';

const fail = (err) => {
  process.stderr.write(`data-dir.mjs failed: ${err.message}\n`);
  process.exit(1);
};

if (process.argv[2] === '--figma') {
  let out;
  try {
    out = figmaDataDir(process.argv[3], process.argv[4]);
  } catch (err) {
    fail(err);
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
} else {
  let projectRoot;
  try {
    projectRoot = realpathSync(resolve(process.argv[2] ?? process.cwd()));
    if (!statSync(projectRoot).isDirectory()) throw new Error(`not a directory: ${projectRoot}`);
  } catch (err) {
    fail(err);
  }
  const dataDir = resolveUaDir(projectRoot);
  process.stdout.write(`${JSON.stringify({ key: basename(dataDir), dataDir, projectRoot })}\n`);
}

function figmaDataDir(keyArg, fileName) {
  if (!keyArg || !fileName?.trim()) throw new Error('usage: data-dir.mjs --figma <fileKey> <fileName>');
  const figmaFileKey = parseFileKey(keyArg);
  const root = join(homedir(), '.claude', 'understand');
  const owner = (key) => {
    try {
      return JSON.parse(readFileSync(join(root, key, 'project.json'), 'utf-8')).figmaFileKey ?? null;
    } catch {
      return null;
    }
  };
  const slug = fileName.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || figmaFileKey;
  const base = `figma-${slug.slice(0, 54)}`;
  const hash = createHash('sha1').update(figmaFileKey).digest('hex').slice(0, 6);
  const known = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith('figma-') && owner(d) === figmaFileKey) : [];
  for (const key of [...known, base, `${base.slice(0, 53)}-${hash}`]) {
    const dir = join(root, key);
    if (existsSync(dir) && owner(key) !== figmaFileKey) continue;
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'project.json'))) {
      const tmp = join(dir, `.project.json.${process.pid}.tmp`);
      writeFileSync(tmp, `${JSON.stringify({ key, kind: 'design', figmaFileKey, figmaFileName: fileName, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf-8');
      try {
        linkSync(tmp, join(dir, 'project.json'));
      } catch {}
      rmSync(tmp, { force: true });
      if (owner(key) !== figmaFileKey) continue;
    }
    return { key, dataDir: dir, kind: 'design', figmaFileKey, figmaFileName: fileName };
  }
  throw new Error(`no free data folder under ${root} for Figma file ${figmaFileKey}`);
}
