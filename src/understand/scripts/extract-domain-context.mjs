#!/usr/bin/env node
/**
 * extract-domain-context.mjs — Lightweight codebase scanner for domain knowledge extraction.
 *
 * Scans a project directory and produces a structured JSON context file that the
 * domain-analyzer agent uses to identify business domains, flows, and steps.
 *
 * Usage:
 *     node extract-domain-context.mjs <project-root>
 *
 * Output:
 *     <ua-dir>/intermediate/domain-context.json, where <ua-dir> is the project's
 *     data dir (resolveUaDir, under ~/.claude/understand/).
 */

import { existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveUaDir } from '../core/index.js';
import { PyError, dumps, err, get, isDict, isDir, kb, loads, pyResolve, pyType, truthy } from './merge-batch-graphs.mjs';

// ── Configuration ──────────────────────────────────────────────────────────

const MAX_FILE_TREE_DEPTH = 6;
const MAX_FILES_PER_DIR = 50;
const MAX_FILES_TOTAL = 5000;
const MAX_SAMPLED_FILES = 40;
const MAX_LINES_PER_FILE = 80;
const MAX_ENTRY_POINTS = 200;
const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB — keeps output within agent context limits

// File extensions we care about for domain analysis
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.go',
  '.rs',
  '.java', '.kt', '.scala',
  '.rb',
  '.cs',
  '.php',
  '.swift',
  '.c', '.cpp', '.h', '.hpp',
  '.ex', '.exs',
  '.hs',
  '.lua',
  '.r', '.R',
]);

// Directories to always skip
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.tox',
  'venv', '.venv', 'env', '.env', 'dist', 'build', 'out', '.next',
  '.nuxt', 'target', 'vendor', '.idea', '.vscode', 'coverage',
  '.understand-anything', '.ua', '.pytest_cache', '.mypy_cache',
  'Pods', 'DerivedData', '.gradle', 'bin', 'obj',
]);

// Files that reveal project metadata
const METADATA_FILES = [
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
  'setup.py', 'setup.cfg', 'pom.xml', 'build.gradle',
  'Gemfile', 'composer.json', 'mix.exs', 'Makefile',
  'docker-compose.yml', 'docker-compose.yaml',
  'README.md', 'README.rst', 'README.txt', 'README',
];

const S =String.raw`[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]`;
const W = String.raw`[\p{L}\p{N}_]`;
const B = String.raw`(?![\p{L}\p{N}_])`;
const BOL = String.raw`(?<![^\n])`;
const I = String.raw`[i\u{131}\u{130}]`;
const re = (src, flags = 'gu') => new RegExp(src, flags);

// ── Entry point detection patterns ─────────────────────────────────────────

const ENTRY_POINT_PATTERNS = [
  // HTTP routes
  ['http', 'Express/Koa route', re(String.raw`(?:app|router|server)${S}*\.${S}*(?:get|post|put|patch|delete|all|use)${S}*\(${S}*['"](/[^'"]*?)['"]`, 'giu')],
  ['http', 'Decorator route (Flask/FastAPI/NestJS)', re(String.raw`@(?:app\.)?(?:route|get|post|put|patch|delete|ap${I}_v${I}ew|RequestMapp${I}ng|GetMapp${I}ng|PostMapp${I}ng)${S}*\(${S}*['"](/[^'"]*?)['"]`, 'giu')],
  ['http', 'Next.js/Remix route handler', re(String.raw`export${S}+(?:async${S}+)?function${S}+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)${B}`)],
  // CLI
  ['cli', 'CLI command', re(String.raw`\.command${S}*\(${S}*['"]([\p{L}\p{N}_\-:]+)['"]`)],
  ['cli', 'argparse subparser', re(String.raw`add_parser${S}*\(${S}*['"]([\p{L}\p{N}_\-]+)['"]`)],
  // Event handlers
  ['event', 'Event listener', re(String.raw`\.on${S}*\(${S}*['"]([\p{L}\p{N}_\-:.]+)['"]`)],
  ['event', 'Event subscriber decorator', re(String.raw`@(?:EventHandler|Subscribe|Listener|on_event)${S}*\(${S}*['"]([\p{L}\p{N}_\-:.]+)['"]`)],
  // Cron / scheduled
  ['cron', 'Cron schedule', re(String.raw`@?(?:Cron|Schedule|Scheduled|crontab)${S}*\(${S}*['"]([^'"]+)['"]`, 'giu')],
  // GraphQL
  ['http', 'GraphQL resolver', re(String.raw`@(?:Query|Mutation|Subscription|Resolver)${S}*\(`)],
  // gRPC (only in .proto files — handled by file extension check below)
  ['http', 'gRPC service', re(String.raw`${BOL}service${S}+(${W}+)${S}*\{`)],
  // Exported handlers (generic)
  ['manual', 'Exported handler', re(String.raw`export${S}+(?:async${S}+)?function${S}+(handle${W}+|process${W}+|on${W}+)${B}`)],
];

const EXPORT_RE = re(String.raw`export${S}+(?:default${S}+)?(?:async${S}+)?(?:function|class|const|let|var|interface|type|enum)${S}+(${W}+)`);
const PY_EXPORT_RE = re(String.raw`${BOL}(?:def|class)${S}+(${W}+)`);
const IMPORT_RE = re(String.raw`(?:import${S}+[^\n]*?from${S}+['"]([^'"]+)['"]|from${S}+([\p{L}\p{N}_.]+)${S}+import)`);
const STRIP_RE = re(String.raw`^${S}+|${S}+$`);

const readText = (path) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(readFileSync(path)).replace(/\r\n?/g, '\n');

function splitlines(s) {
  const lines = s.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u{2028}\u{2029}]/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function cut(s, n) {
  if (s.length <= n) return s;
  let i = 0;
  for (let k = 0; k < n && i < s.length; k++) i += s.codePointAt(i) > 0xffff ? 2 : 1;
  return s.slice(0, i);
}

function codePointCompare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const sx = x >= 0xd800 && x <= 0xdfff;
    const sy = y >= 0xd800 && y <= 0xdfff;
    return sx === sy ? x - y : sx ? 1 : -1;
  }
  return a.length - b.length;
}

const count = (s, ch) => s.split(ch).length - 1;
const asciiJson = (v) => dumps(v).replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function suffix(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i) : '';
}

const statOr = (fn, p) => {
  try {
    return fn(p);
  } catch {
    return null;
  }
};
const isSymlink = (p) => statOr(lstatSync, p)?.isSymbolicLink() ?? false;
const isFile = (p) => statOr(statSync, p)?.isFile() ?? false;

function listDir(path) {
  const dir = opendirSync(path);
  const names = [];
  try {
    for (let d; (d = dir.readSync()) !== null; ) names.push(d.name);
  } finally {
    dir.closeSync();
  }
  return names;
}

// ── Gitignore support ──────────────────────────────────────────────────────

/** Parse .gitignore into a list of compiled regex patterns. */
function parseGitignore(projectRoot) {
  const gitignore = join(projectRoot, '.gitignore');
  const patterns = [];
  if (!existsSync(gitignore)) return patterns;

  for (let line of splitlines(readText(gitignore))) {
    line = line.replace(STRIP_RE, '');
    if (!line || line.startsWith('#')) continue;
    // Convert glob to regex (simplified)
    let regex = line.split('.').join('\\.').split('**/').join('(.*/)?').split('*').join('[^/]*').split('?').join('[^/]');
    if (line.endsWith('/')) regex = `${regex.replace(/\/+$/, '')}(/|$)`;
    try {
      // ponytail: JS RegExp judges validity (u-mode, then Annex B); python's re differs on malformed lines (bad escapes, possessive ++) and words errors differently
      let compiled;
      try {
        compiled = new RegExp(regex, 'u');
      } catch {
        compiled = new RegExp(regex);
      }
      patterns.push(compiled);
    } catch (e) {
      err(`Warning: skipping invalid gitignore pattern '${line}': ${e.message}`);
    }
  }
  return patterns;
}

/** Check if a relative path matches any gitignore pattern. */
const isIgnored = (relPath, gitignorePatterns) => gitignorePatterns.some((pattern) => pattern.test(relPath));

// ── File tree scanner ──────────────────────────────────────────────────────

/** Return a flat list of relative file paths (source files only). */
function scanFileTree(root, gitignorePatterns, maxDepth = MAX_FILE_TREE_DEPTH) {
  const result = [];

  const walk = (dirPath, relDir, depth) => {
    if (depth > maxDepth || result.length >= MAX_FILES_TOTAL) return;
    let entries;
    try {
      entries = listDir(dirPath).map((name) => {
        const path = join(dirPath, name);
        return { name, path, dir: isDir(path), key: name.toLowerCase() };
      });
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') return;
      throw e;
    }
    entries.sort((a, b) => (a.dir === b.dir ? codePointCompare(a.key, b.key) : a.dir ? -1 : 1));

    let fileCount = 0;
    for (const entry of entries) {
      if (result.length >= MAX_FILES_TOTAL) break;
      // Skip symlinks to avoid infinite loops
      if (isSymlink(entry.path)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isDir(entry.path)) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (isIgnored(`${rel}/`, gitignorePatterns)) continue;
        walk(entry.path, rel, depth + 1);
      } else if (isFile(entry.path)) {
        if (fileCount >= MAX_FILES_PER_DIR) break;
        if (!SOURCE_EXTENSIONS.has(suffix(entry.name))) continue;
        if (isIgnored(rel, gitignorePatterns)) continue;
        result.push(rel);
        fileCount += 1;
      }
    }
  };

  walk(root, '', 0);
  return result;
}

// ── Entry point detection ──────────────────────────────────────────────────

/** Scan source files for entry point patterns. */
function detectEntryPoints(root, filePaths) {
  const entryPoints = [];

  // Skip test files and the extraction script itself
  const testPatterns = re(String.raw`(?:\.test\.|\.spec\.|__tests__|_test\.py|test_${W}+\.py|extract-domain-context\.(?:py|mjs))`, 'u');

  for (const relPath of filePaths) {
    if (entryPoints.length >= MAX_ENTRY_POINTS) break;
    if (testPatterns.test(relPath)) continue;
    let content;
    try {
      content = readText(join(root, relPath));
    } catch {
      continue;
    }

    const lines = splitlines(content);
    for (const [entryType, description, pattern] of ENTRY_POINT_PATTERNS) {
      for (const match of content.matchAll(pattern)) {
        // Find line number
        const lineNo = count(content.slice(0, match.index), '\n') + 1;
        // Extract a snippet (signature + a few lines)
        const start = Math.max(0, lineNo - 1);
        const end = Math.min(lines.length, start + 5);
        const snippet = lines.slice(start, end).join('\n');

        entryPoints.push({
          file: relPath,
          line: lineNo,
          type: entryType,
          description,
          match: cut(match[0], 120),
          snippet: cut(snippet, 300),
        });

        if (entryPoints.length >= MAX_ENTRY_POINTS) break;
      }
      if (entryPoints.length >= MAX_ENTRY_POINTS) break;
    }
  }

  return entryPoints;
}

// ── File signatures ────────────────────────────────────────────────────────

/** Extract exports and imports from each file (lightweight). */
function extractFileSignatures(root, filePaths) {
  const signatures = [];

  // Prioritize files likely to contain business logic
  const priorityKeywords = [
    'controller', 'service', 'handler', 'router', 'route', 'api',
    'model', 'entity', 'repository', 'usecase', 'use_case',
    'command', 'query', 'event', 'subscriber', 'listener',
    'middleware', 'guard', 'interceptor', 'resolver',
    'workflow', 'flow', 'process', 'pipeline', 'job', 'task',
  ];

  const priorityScore = (path) => {
    const lower = path.toLowerCase();
    return priorityKeywords.filter((kw) => lower.includes(kw)).length;
  };

  const sortedPaths = filePaths.map((p) => [priorityScore(p), p]).sort((a, b) => b[0] - a[0]).map(([, p]) => p);

  for (const relPath of sortedPaths.slice(0, MAX_SAMPLED_FILES)) {
    let content;
    try {
      content = readText(join(root, relPath));
    } catch {
      continue;
    }

    const allLines = splitlines(content);
    const truncated = allLines.slice(0, MAX_LINES_PER_FILE).join('\n');

    // Extract exports (JS/TS)
    let exports = [...truncated.matchAll(EXPORT_RE)].map((m) => m[1]);
    // Extract exports (Python)
    if (!exports.length) exports = [...truncated.matchAll(PY_EXPORT_RE)].map((m) => m[1]);

    // Extract imports (first 20)
    const importList = [...truncated.matchAll(IMPORT_RE)].map((m) => m[1] || m[2]).slice(0, 20);

    signatures.push({
      file: relPath,
      exports: exports.slice(0, 20),
      imports: importList,
      lines: allLines.length,
      preview: cut(truncated, 500),
    });
  }

  return signatures;
}

// ── Metadata extraction ────────────────────────────────────────────────────

function keysOf(v) {
  if (!truthy(v)) return [];
  if (!isDict(v)) throw new TypeError(`'${pyType(v)}' object has no attribute 'keys'`);
  return Object.keys(v);
}

/** Read project metadata files. */
function extractMetadata(root) {
  const metadata = {};

  for (const filename of METADATA_FILES) {
    const filepath = join(root, filename);
    if (!existsSync(filepath)) continue;
    let content;
    try {
      content = readText(filepath);
    } catch {
      continue;
    }

    if (filename === 'package.json') {
      let pkg;
      try {
        pkg = loads(content);
      } catch (e) {
        if (!(e instanceof PyError)) throw e;
        metadata['package.json'] = cut(content, 500);
        continue;
      }
      metadata['package.json'] = {
        name: get(pkg, 'name'),
        description: get(pkg, 'description'),
        scripts: keysOf(get(pkg, 'scripts')),
        dependencies: keysOf(get(pkg, 'dependencies')),
        devDependencies: keysOf(get(pkg, 'devDependencies')),
      };
    } else if (/\.(?:md|rst|txt)$/.test(filename) || filename === 'README') {
      metadata[filename] = cut(content, 2000);
    } else if (/\.(?:toml|cfg|mod)$/.test(filename)) {
      metadata[filename] = cut(content, 1000);
    } else if (/\.(?:json|yml|yaml|xml|gradle)$/.test(filename)) {
      metadata[filename] = cut(content, 1000);
    }
  }

  return metadata;
}

// ── Main ───────────────────────────────────────────────────────────────────

/** Progressively trim context sections to stay under MAX_OUTPUT_BYTES. */
function truncateToFit(context) {
  if (asciiJson(context).length <= MAX_OUTPUT_BYTES) return context;

  // 1. Trim file tree to just a count
  context.fileTree = context.fileTree.slice(0, 200);
  if (asciiJson(context).length <= MAX_OUTPUT_BYTES) return context;

  // 2. Trim previews in signatures
  for (const sig of context.fileSignatures) sig.preview = cut(sig.preview, 200);
  if (asciiJson(context).length <= MAX_OUTPUT_BYTES) return context;

  // 3. Trim snippets in entry points
  for (const ep of context.entryPoints) ep.snippet = cut(ep.snippet, 100);
  if (asciiJson(context).length <= MAX_OUTPUT_BYTES) return context;

  // 4. Reduce number of signatures and entry points
  context.fileSignatures = context.fileSignatures.slice(0, 20);
  context.entryPoints = context.entryPoints.slice(0, 100);

  return context;
}

function main() {
  if (process.argv.length < 3) {
    err('Usage: node extract-domain-context.mjs <project-root>');
    process.exit(1);
  }

  const projectRoot = pyResolve(process.argv[2]);
  if (!isDir(projectRoot)) {
    err(`Error: ${projectRoot} is not a directory`);
    process.exit(1);
  }

  try {
    // Ensure output directory exists
    const outputDir = join(resolveUaDir(projectRoot), 'intermediate');
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, 'domain-context.json');

    err(`Scanning ${projectRoot} ...`);

    const gitignorePatterns = parseGitignore(projectRoot);
    const fileTree = scanFileTree(projectRoot, gitignorePatterns);
    err(`  Found ${fileTree.length} source files`);

    const entryPoints = detectEntryPoints(projectRoot, fileTree);
    err(`  Detected ${entryPoints.length} entry points`);

    const signatures = extractFileSignatures(projectRoot, fileTree);
    err(`  Extracted ${signatures.length} file signatures`);

    const metadata = extractMetadata(projectRoot);
    err(`  Read ${Object.keys(metadata).length} metadata files`);

    const context = truncateToFit({
      projectRoot,
      fileCount: fileTree.length,
      fileTree,
      entryPoints,
      fileSignatures: signatures,
      metadata,
    });
    writeFileSync(outputPath, asciiJson(context));
    err(`  Wrote ${outputPath} (${kb(outputPath)} KB)`);
  } catch (e) {
    err(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
