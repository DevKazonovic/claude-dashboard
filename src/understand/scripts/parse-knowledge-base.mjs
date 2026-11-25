#!/usr/bin/env node
/**
 * parse-knowledge-base.mjs — Deterministic parser for Karpathy-pattern LLM wikis.
 *
 * Node port of Understand Anything's parse-knowledge-base.py (same argument,
 * same scan-manifest.json bytes, same stderr report).
 *
 * Detects the three-layer pattern (raw sources + wiki markdown + schema),
 * extracts structure from markdown files, resolves wikilinks, and derives
 * categories from index.md section headings.
 *
 * Usage:
 *     node parse-knowledge-base.mjs <wiki-directory>
 *
 * Output:
 *     Writes scan-manifest.json to <data-dir>/intermediate/, where <data-dir>
 *     is the wiki's own data folder (resolveUaDir), never inside the wiki.
 */

import { existsSync, mkdirSync, opendirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveUaDir } from '../core/index.js';
import { dumps, err, isDict, isDir, kb, pyResolve } from './merge-batch-graphs.mjs';

const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const strip = (s) => s.replace(STRIP_RE, '');
const ascii = (s) => s.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const compact = (v) => (isDict(v) ? `{${Object.keys(v).map((k) => `${dumps(k)}: ${compact(v[k])}`).join(', ')}}` : dumps(v));
const readText = (p) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const cmpStr = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const cmpPath = (a, b) => {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return cmpStr(x[i], y[i]);
  return x.length - y.length;
};
const pyStem = (name) => (name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name);
const pySuffix = (name) => (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')) : '');
const lastPart = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const withoutSuffix = (rel) => rel.slice(0, rel.lastIndexOf('/') + 1) + pyStem(lastPart(rel));
const isMd = (name) => name.endsWith('.md');

const scandir = (dir) => {
  try {
    const d = opendirSync(dir);
    try {
      const out = [];
      for (let e; (e = d.readSync()); ) out.push(e);
      return out;
    } finally {
      d.closeSync();
    }
  } catch {
    return [];
  }
};

// Python 3.14 Path.rglob(): raw scandir order, LIFO directory stack, symlinked dirs not followed.
function rglob(root, match) {
  const out = [];
  const pick = (rel) => {
    for (const e of scandir(join(root, rel))) if (match(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name);
  };
  pick('');
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of scandir(join(root, rel))) {
      if (!e.isDirectory()) continue;
      const sub = rel ? `${rel}/${e.name}` : e.name;
      pick(sub);
      stack.push(sub);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const FRONTMATTER_RE = new RegExp(`^---[${PY_WS}]*\\n([\\s\\S]*?)\\n---[${PY_WS}]*\\n`);
const HEADING_RE = new RegExp(`(?<![^\\n])(#{1,6})[${PY_WS}]+([^\\n]+)(?![^\\n])`, 'g');
const RULE_RE = new RegExp(`^[-*_]{3,}[${PY_WS}]*$`);
const SECTION_RE = new RegExp(`^##[${PY_WS}]+([^\\n]+)$`);
const LOG_ENTRY_RE = new RegExp(
  `(?<![^\\n])##[${PY_WS}]+\\[(\\p{Nd}{4}-\\p{Nd}{2}-\\p{Nd}{2})\\][${PY_WS}]+([\\p{L}\\p{N}_]+)[${PY_WS}]*\\|[${PY_WS}]*([^\\n]+)(?![^\\n])`,
  'gu',
);

// Files that are part of wiki infrastructure, not content articles
const INFRA_FILES = new Set(['index.md', 'log.md', 'claude.md', 'agents.md', 'soul.md']);

// Resolve a known markdown filename case-insensitively within one directory.
// An exact match always wins; otherwise the first case-insensitive sibling.
function findMarkdownCaseInsensitive(parent, name) {
  const candidate = join(parent, name);
  if (isFile(candidate) || !isDir(parent)) return candidate;
  const wanted = name.toLowerCase();
  const hit = readdirSync(parent)
    .sort(cmpStr)
    .find((child) => isFile(join(parent, child)) && child.toLowerCase() === wanted);
  return hit === undefined ? candidate : join(parent, hit);
}

// ---------------------------------------------------------------------------
// Detection: is this a Karpathy-pattern wiki?
// ---------------------------------------------------------------------------

function detectFormat(root) {
  const wiki = join(root, 'wiki');
  const signals = {
    has_index: isFile(findMarkdownCaseInsensitive(root, 'index.md')) || isFile(findMarkdownCaseInsensitive(wiki, 'index.md')),
    has_log: isFile(findMarkdownCaseInsensitive(root, 'log.md')) || isFile(findMarkdownCaseInsensitive(wiki, 'log.md')),
    has_raw: isDir(join(root, 'raw')),
    has_schema: ['CLAUDE.md', 'AGENTS.md'].some((f) => isFile(join(root, f)) || isFile(join(wiki, f))),
  };

  // Find the wiki root — could be the directory itself or a wiki/ subdirectory
  const wikiRoot = isDir(wiki) ? wiki : root;
  signals.md_count = rglob(wikiRoot, isMd).length;
  signals.wiki_root = wikiRoot;

  // Primary signal: has index.md + meaningful number of markdown files
  signals.detected = signals.has_index && signals.md_count >= 3;
  signals.format = signals.detected ? 'karpathy' : 'unknown';
  return signals;
}

// ---------------------------------------------------------------------------
// Markdown extraction helpers
// ---------------------------------------------------------------------------

function extractFrontmatter(text) {
  const fm = new Map();
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return fm;
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    fm.set(strip(line.slice(0, i)), strip(line.slice(i + 1)).replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, ''));
  }
  return fm;
}

const extractWikilinks = (text) => [...text.matchAll(WIKILINK_RE)].map((m) => strip(m[1]));

const cut200 = (s) => {
  const cps = [...s];
  return cps.length > 200 ? `${cps.slice(0, 197).join('')}...` : s;
};

// Extract the first non-empty paragraph after frontmatter and H1.
function extractFirstParagraph(text) {
  const stripped = strip(text.replace(FRONTMATTER_RE, ''));
  if (!stripped) return '';
  const lines = stripped.split('\n');

  const collectParagraph = (startLines) => {
    const para = [];
    for (const raw of startLines) {
      const s = strip(raw);
      if (!s && !para.length) continue; // Skip leading blank lines
      if (!s && para.length) break; // End of paragraph
      if (s.startsWith('>')) continue; // Skip blockquotes
      if (RULE_RE.test(s)) continue; // Skip horizontal rules
      if (s.startsWith('#')) {
        if (para.length) break; // End paragraph at next heading
        continue; // Skip headings before paragraph
      }
      para.push(s);
    }
    return para.join(' ');
  };

  // Try: find first paragraph after H1
  for (let i = 0; i < lines.length; i++) {
    if (!strip(lines[i]).startsWith('# ')) continue;
    const result = collectParagraph(lines.slice(i + 1));
    if (result) return cut200(result);
  }

  // Fallback: no H1 found, take first paragraph from start
  return cut200(collectParagraph(lines));
}

function extractH1(text) {
  for (const m of text.matchAll(HEADING_RE)) if (m[1].length === 1) return strip(m[2]);
  return '';
}

// ---------------------------------------------------------------------------
// Index.md parsing — categories come from section headings
// ---------------------------------------------------------------------------

function parseIndex(indexPath) {
  if (!isFile(indexPath)) return [];
  const categories = [];
  let current = null;
  for (const line of readText(indexPath).split('\n')) {
    const sec = SECTION_RE.exec(line);
    if (sec) {
      current = { name: strip(sec[1]), articles: [] };
      categories.push(current);
      continue;
    }
    // Collect wikilinks under current section
    if (current) for (const wl of line.matchAll(WIKILINK_RE)) current.articles.push(strip(wl[1]));
  }
  return categories;
}

// Log.md parsing — only the number of chronological entries is used
const countLogEntries = (logPath) => (isFile(logPath) ? [...readText(logPath).matchAll(LOG_ENTRY_RE)].length : 0);

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

// Full relative paths always map uniquely. Bare basenames map only when
// unambiguous — duplicate basenames are removed so they don't silently
// resolve to the wrong page.
function buildNameToStemMap(wikiRoot) {
  const nameMap = new Map();
  const basenameCounts = new Map();
  for (const rel of rglob(wikiRoot, isMd)) {
    const stem = withoutSuffix(rel);
    const key = pyStem(lastPart(rel)).toLowerCase();
    nameMap.set(stem.toLowerCase(), stem);
    basenameCounts.set(key, (basenameCounts.get(key) ?? 0) + 1);
    nameMap.set(key, stem);
  }
  for (const [key, count] of basenameCounts) if (count > 1) nameMap.delete(key);
  return nameMap;
}

// Resolve a wikilink target to an article node ID. Links written from the
// repository root include the article-root prefix ([[wiki/concepts/Index]]),
// so such targets are tried both as written and with the prefix stripped.
function resolveWikilink(target, nameMap, nodeIds, rootPrefix) {
  const key = strip(target.toLowerCase());
  // Skip targets that are clearly not page names (shell flags, etc.)
  if (key.startsWith('-')) return null;
  const keys = [key];
  if (rootPrefix && key.startsWith(`${rootPrefix}/`)) keys.push(key.slice(rootPrefix.length + 1));
  const known = (stem) => {
    const candidate = `article:${stem}`;
    return nodeIds && !nodeIds.has(candidate) ? null : candidate;
  };
  for (const k of keys) {
    const stem = nameMap.get(k);
    if (stem) return known(stem);
  }
  // Try without directory prefix
  for (const k of keys) {
    for (const [storedKey, storedStem] of nameMap) if (storedKey.endsWith(`/${k}`) || storedKey === k) return known(storedStem);
  }
  return null;
}

function parseWiki(root) {
  const detection = detectFormat(root);
  if (!detection.detected) {
    err(ascii(compact({ error: 'Not a Karpathy-pattern wiki', detection })));
    process.exit(1);
  }

  const wikiRoot = detection.wiki_root;
  const rawRoot = join(root, 'raw');
  const nameMap = buildNameToStemMap(wikiRoot);

  let indexPath = findMarkdownCaseInsensitive(wikiRoot, 'index.md');
  if (!isFile(indexPath)) indexPath = findMarkdownCaseInsensitive(root, 'index.md');
  let logPath = findMarkdownCaseInsensitive(wikiRoot, 'log.md');
  if (!isFile(logPath)) logPath = findMarkdownCaseInsensitive(root, 'log.md');

  const categories = parseIndex(indexPath);
  const logEntries = countLogEntries(logPath);
  const rootPrefix = wikiRoot !== root ? basename(wikiRoot).toLowerCase() : null;

  // Build category lookup: wikilink target → category name
  const categoryLookup = new Map();
  for (const cat of categories) {
    for (const articleTarget of cat.articles) {
      const t = articleTarget.toLowerCase();
      categoryLookup.set(t, cat.name);
      if (rootPrefix && t.startsWith(`${rootPrefix}/`)) categoryLookup.set(t.slice(rootPrefix.length + 1), cat.name);
    }
  }

  // Only skip infra files at the wiki root level, not in subdirectories
  // (e.g., wiki/index.md is infra, but wiki/concepts/index.md is content)
  const isInfra = (rel) => !rel.includes('/') && INFRA_FILES.has(rel.toLowerCase());
  const mdFiles = rglob(wikiRoot, isMd).sort(cmpPath);
  const articleIds = new Set(mdFiles.filter((rel) => !isInfra(rel)).map((rel) => `article:${withoutSuffix(rel)}`));

  const nodes = [];
  const edges = [];
  const warnings = [];
  const stats = { articles: 0, sources: 0, topics: 0, wikilinks: 0, unresolved: 0 };

  for (const rel of mdFiles) {
    if (isInfra(rel)) continue;
    const stem = withoutSuffix(rel);
    const base = pyStem(lastPart(rel));
    const text = readText(join(wikiRoot, rel));
    const h1 = extractH1(text);
    const frontmatter = extractFrontmatter(text);
    const wikilinks = extractWikilinks(text);
    const summary = extractFirstParagraph(text);

    // Derive category from index.md lookup
    let category = categoryLookup.get(base.toLowerCase()) ?? '';
    if (!category) category = categoryLookup.get(stem.toLowerCase()) ?? '';

    // Derive tags (deduplicated)
    const tagSet = new Set();
    if (category) tagSet.add(category.toLowerCase());
    if (rel.includes('/')) tagSet.add(rel.slice(0, rel.lastIndexOf('/')));
    const fmTags = frontmatter.get('tags') ?? '';
    if (fmTags) for (const t of fmTags.split(',')) if (strip(t)) tagSet.add(strip(t));
    const tags = [...tagSet].sort(cmpStr);

    // Complexity from wikilink density
    const complexity = wikilinks.length > 15 ? 'complex' : wikilinks.length > 5 ? 'moderate' : 'simple';

    const nodeId = `article:${stem}`;
    const knowledgeMeta = { wikilinks };
    if (category) knowledgeMeta.category = category;
    knowledgeMeta.content = text.match(/^[\s\S]{0,3000}/u)[0]; // First 3000 chars for LLM analysis
    nodes.push({
      id: nodeId,
      type: 'article',
      name: h1 || base,
      filePath: rel,
      summary: summary || `Wiki article: ${h1 || base}`,
      tags,
      complexity,
      knowledgeMeta,
    });
    stats.articles += 1;
    stats.wikilinks += wikilinks.length;

    // Build edges from wikilinks (resolve against known article IDs)
    for (const target of wikilinks) {
      const targetId = resolveWikilink(target, nameMap, articleIds, rootPrefix);
      if (targetId && targetId !== nodeId) {
        edges.push({ source: nodeId, target: targetId, type: 'related', direction: 'forward', weight: 0.7 });
      } else if (!targetId) {
        warnings.push(`Unresolved wikilink: [[${target}]] in ${rel}`);
        stats.unresolved += 1;
      }
    }
  }

  // --- Build topic nodes from index.md categories ---
  for (const cat of categories) {
    const topicId = `topic:${cat.name.toLowerCase().replaceAll(' ', '-')}`;
    nodes.push({
      id: topicId,
      type: 'topic',
      name: cat.name,
      summary: `Category from index: ${cat.name} (${cat.articles.length} articles)`,
      tags: ['category'],
      complexity: 'simple',
    });
    stats.topics += 1;

    // categorized_under edges (only resolve to known article nodes)
    for (const articleTarget of cat.articles) {
      const articleId = resolveWikilink(articleTarget, nameMap, articleIds, rootPrefix);
      if (articleId) edges.push({ source: articleId, target: topicId, type: 'categorized_under', direction: 'forward', weight: 0.6 });
    }
  }

  // --- Build source nodes from raw/ ---
  if (isDir(rawRoot)) {
    for (const rel of rglob(rawRoot, () => true).sort(cmpPath)) {
      const name = lastPart(rel);
      const file = join(rawRoot, rel);
      if (!isFile(file) || name.startsWith('.')) continue;
      const ext = pySuffix(name).toLowerCase();
      nodes.push({
        id: `source:${withoutSuffix(rel)}`,
        type: 'source',
        name,
        filePath: `raw/${rel}`,
        summary: `Raw source (${ext || 'unknown'}, ${kb(file)} KB)`,
        tags: ['raw', ext.replace(/^\.+/, '') || 'unknown'],
        complexity: 'simple',
      });
      stats.sources += 1;
    }
  }

  // --- Compute backlinks ---
  const backlinkMap = new Map();
  for (const edge of edges) {
    if (edge.type !== 'related') continue;
    if (!backlinkMap.has(edge.target)) backlinkMap.set(edge.target, []);
    backlinkMap.get(edge.target).push(edge.source);
  }
  for (const node of nodes) if (node.type === 'article' && node.knowledgeMeta) node.knowledgeMeta.backlinks = backlinkMap.get(node.id) ?? [];

  // --- Deduplicate edges ---
  const seen = new Set();
  const dedupedEdges = edges.filter((edge) => {
    const key = JSON.stringify([edge.source, edge.target, edge.type]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    format: 'karpathy',
    stats,
    categories: categories.map((c) => ({ name: c.name, count: c.articles.length })),
    logEntries,
    nodes,
    edges: dedupedEdges,
    warnings: warnings.slice(0, 50),
  };
}

function holdsCodeMap(dataDir) {
  let kind = null;
  try {
    kind = JSON.parse(readFileSync(join(dataDir, 'knowledge-graph.json'), 'utf8')).kind ?? 'code';
  } catch (e) {
    if (e.code !== 'ENOENT') kind = 'code';
  }
  return (kind !== null && kind !== 'knowledge') || existsSync(join(dataDir, 'fingerprints.json')) || existsSync(join(dataDir, 'intermediate', 'scan-result.json'));
}

function main() {
  if (process.argv.length < 3) {
    err('Usage: node parse-knowledge-base.mjs <wiki-directory>');
    process.exit(1);
  }

  const root = pyResolve(process.argv[2]);
  if (!isDir(root)) {
    err(`Error: ${root} is not a directory`);
    process.exit(1);
  }

  const manifest = parseWiki(root);

  const dataDir = resolveUaDir(root);
  if (holdsCodeMap(dataDir)) {
    err(`Error: ${dataDir} holds the code map of ${root}. A wiki map is never written into a code map's folder.`);
    process.exit(1);
  }
  const outDir = join(dataDir, 'intermediate');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'scan-manifest.json');
  writeFileSync(outPath, ascii(dumps(manifest)));

  const s = manifest.stats;
  err(`[parse] Karpathy wiki: ${s.articles} articles, ${s.sources} sources, ${s.topics} topics, ${s.wikilinks} wikilinks (${s.unresolved} unresolved)`);
  err(`[parse] Output: ${outPath}`);
}

main();
