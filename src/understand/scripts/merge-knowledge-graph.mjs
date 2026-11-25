#!/usr/bin/env node
/**
 * merge-knowledge-graph.mjs — Merge script for Karpathy-pattern knowledge graphs.
 *
 * Node port of Understand Anything's merge-knowledge-graph.py (same argument,
 * same assembled-graph.json bytes apart from analyzedAt, same stderr report).
 *
 * Combines the deterministic scan-manifest.json with LLM analysis batches
 * (analysis-batch-*.json) into a final assembled knowledge graph.
 *
 * Handles: entity deduplication, edge normalization, layer building from
 * index.md categories, tour generation from index.md section ordering.
 *
 * Usage:
 *     node merge-knowledge-graph.mjs <wiki-directory>
 *
 * Output:
 *     Writes assembled-graph.json to <data-dir>/intermediate/, where
 *     <data-dir> is the wiki's own data folder (resolveUaDir).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveUaDir } from '../core/index.js';
import { PyError, dumps, err, get, isDir, loadJson, pyResolve, pyStr, truthy } from './merge-batch-graphs.mjs';

const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const WS_RUN_RE = new RegExp(`[${PY_WS}]+`, 'g');
const H1_RE = new RegExp(`(?<![^\\n])#[${PY_WS}]+([^\\n]+)(?![^\\n])`);
const strip = (s) => s.replace(STRIP_RE, '');
const ascii = (s) => s.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const readText = (p) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const cmpStr = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const isoNow = () => new Date().toISOString().replace(/\.(\d{3})Z$/, (_, ms) => (ms === '000' ? '+00:00' : `.${ms}000+00:00`));
const slug = (name) => name.toLowerCase().replaceAll(' ', '-');

// Mirrors findMarkdownCaseInsensitive in parse-knowledge-base.mjs (the
// scripts are standalone, so the helper is duplicated).
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
// Canonical type sets (must match core/src/types.ts)
// ---------------------------------------------------------------------------

const VALID_NODE_TYPES = new Set([
  'article', 'entity', 'topic', 'claim', 'source',
  // Codebase types (for cross-compatibility)
  'file', 'function', 'class', 'module', 'concept',
  'config', 'document', 'service', 'table', 'endpoint',
  'pipeline', 'schema', 'resource', 'domain', 'flow', 'step',
]);

const VALID_EDGE_TYPES = new Set([
  'cites', 'contradicts', 'builds_on', 'exemplifies',
  'categorized_under', 'authored_by', 'related', 'similar_to',
  // Codebase types
  'imports', 'exports', 'contains', 'inherits', 'implements',
  'calls', 'subscribes', 'publishes', 'middleware',
  'reads_from', 'writes_to', 'transforms', 'validates',
  'depends_on', 'tested_by', 'configures',
  'deploys', 'serves', 'provisions', 'triggers',
  'migrates', 'documents', 'routes', 'defines_schema',
  'contains_flow', 'flow_step', 'cross_domain',
]);

const NODE_TYPE_ALIASES = new Map(Object.entries({
  note: 'article', page: 'article', wiki_page: 'article',
  person: 'entity', actor: 'entity', organization: 'entity',
  tag: 'topic', category: 'topic', theme: 'topic',
  assertion: 'claim', decision: 'claim', thesis: 'claim',
  reference: 'source', raw: 'source', paper: 'source',
}));

const EDGE_TYPE_ALIASES = new Map(Object.entries({
  references: 'cites', cites_source: 'cites',
  conflicts_with: 'contradicts', disagrees_with: 'contradicts',
  refines: 'builds_on', elaborates: 'builds_on',
  illustrates: 'exemplifies', instance_of: 'exemplifies', example_of: 'exemplifies',
  belongs_to: 'categorized_under', tagged_with: 'categorized_under',
  written_by: 'authored_by', created_by: 'authored_by',
  relates_to: 'related', related_to: 'related',
}));

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const normalize = (aliases) => (t) => {
  const key = strip(t.toLowerCase());
  return aliases.get(key) ?? key;
};
const normalizeNodeType = normalize(NODE_TYPE_ALIASES);
const normalizeEdgeType = normalize(EDGE_TYPE_ALIASES);
// Normalize entity names for deduplication.
const normalizeEntityName = (name) => strip(name).toLowerCase().replace(WS_RUN_RE, ' ');

// ---------------------------------------------------------------------------
// Merge pipeline
// ---------------------------------------------------------------------------

function merge(root) {
  const intermediate = join(resolveUaDir(root), 'intermediate');
  const manifestPath = join(intermediate, 'scan-manifest.json');

  if (!isFile(manifestPath)) {
    err(`Error: ${manifestPath} not found. Run parse-knowledge-base.mjs first.`);
    process.exit(1);
  }

  // Load scan manifest (deterministic base)
  const manifest = loadJson(manifestPath);
  const nodes = new Map(manifest.nodes.map((n) => [n.id, n]));
  const edges = [...manifest.edges];

  const report = {
    base_nodes: nodes.size, base_edges: edges.length,
    batches: 0, new_entities: 0, new_claims: 0,
    new_edges: 0, deduped_entities: 0, dropped_edges: 0,
  };

  // Load analysis batches
  const batchFiles = readdirSync(intermediate).filter((n) => /^analysis-batch-[\s\S]*\.json$/.test(n)).sort(cmpStr);
  const entityNameMap = new Map(); // normalized_name → entity_id
  const dedupRemap = new Map(); // duplicate_id → canonical_id

  for (const bf of batchFiles) {
    report.batches += 1;
    let batch;
    try {
      batch = loadJson(join(intermediate, bf));
    } catch (e) {
      if (!(e instanceof PyError)) throw e;
      err(`[merge] Warning: Failed to load ${bf}: ${e.message}`);
      continue;
    }

    // Process new nodes from LLM analysis
    for (const node of get(batch, 'nodes', [])) {
      const nodeType = normalizeNodeType(get(node, 'type', ''));
      if (!VALID_NODE_TYPES.has(nodeType)) {
        err(`[merge] Warning: Unknown node type '${pyStr(get(node, 'type'))}' — skipping`);
        continue;
      }

      node.type = nodeType;
      const nodeId = get(node, 'id', '');

      // Entity deduplication — track remapping for edge fixup
      if (nodeType === 'entity') {
        const normName = normalizeEntityName(get(node, 'name', ''));
        if (entityNameMap.has(normName)) {
          // Map duplicate ID → canonical ID for edge remapping
          dedupRemap.set(nodeId, entityNameMap.get(normName));
          report.deduped_entities += 1;
          continue;
        }
        entityNameMap.set(normName, nodeId);
        report.new_entities += 1;
      } else if (nodeType === 'claim') {
        report.new_claims += 1;
      }

      // Ensure required fields
      if (!Object.hasOwn(node, 'summary')) node.summary = get(node, 'name', '');
      if (!Object.hasOwn(node, 'tags')) node.tags = [];
      if (!Object.hasOwn(node, 'complexity')) node.complexity = 'simple';

      nodes.set(nodeId, node);
    }

    // Process new edges from LLM analysis
    for (const edge of get(batch, 'edges', [])) {
      let edgeType = normalizeEdgeType(get(edge, 'type', ''));
      if (!VALID_EDGE_TYPES.has(edgeType)) {
        err(`[merge] Warning: Unknown edge type '${pyStr(get(edge, 'type'))}' — mapped to 'related'`);
        edgeType = 'related';
      }

      edge.type = edgeType;
      if (!Object.hasOwn(edge, 'direction')) edge.direction = 'forward';
      if (!Object.hasOwn(edge, 'weight')) edge.weight = 0.5;

      // Remap deduped entity IDs, then validate source/target exist
      const source = get(edge, 'source', '');
      const target = get(edge, 'target', '');
      const src = dedupRemap.has(source) ? dedupRemap.get(source) : source;
      const tgt = dedupRemap.has(target) ? dedupRemap.get(target) : target;
      edge.source = src;
      edge.target = tgt;
      if (nodes.has(src) && nodes.has(tgt)) {
        edges.push(edge);
        report.new_edges += 1;
      } else {
        report.dropped_edges += 1;
      }
    }
  }

  // --- Deduplicate edges ---
  const seen = new Set();
  const finalEdges = edges.filter((edge) => {
    const key = JSON.stringify([edge.source, edge.target, edge.type]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const categorizedUnder = (topicId) => finalEdges.filter((e) => e.type === 'categorized_under' && e.target === topicId).map((e) => e.source);

  // --- Build article→layer map from categories ---
  const categories = get(manifest, 'categories', []);
  const articleLayerMap = new Map(); // article_id → layer_id
  const layerMembers = new Map(); // layer_id → [node_ids]

  for (const cat of categories) {
    const catSlug = slug(cat.name);
    const layerId = `layer:${catSlug}`;
    const topicId = `topic:${catSlug}`;
    const members = categorizedUnder(topicId);
    if (nodes.has(topicId)) members.push(topicId);
    layerMembers.set(layerId, members);
    for (const mid of members) articleLayerMap.set(mid, layerId);
  }

  // --- Assign entity/claim nodes to their parent article's layer ---
  // Step 1: Build entity/claim → article mapping from edges
  const typeOf = (id) => (nodes.has(id) ? get(nodes.get(id), 'type', '') : '');
  const isChild = (t) => t === 'entity' || t === 'claim';
  const childToArticle = new Map();
  for (const edge of finalEdges) {
    const srcType = typeOf(edge.source);
    const tgtType = typeOf(edge.target);
    // If an article connects to an entity/claim, map the child to the article
    if (srcType === 'article' && isChild(tgtType)) {
      if (!childToArticle.has(edge.target)) childToArticle.set(edge.target, edge.source);
    } else if (tgtType === 'article' && isChild(srcType)) {
      if (!childToArticle.has(edge.source)) childToArticle.set(edge.source, edge.target);
    }
  }

  // Step 2: For orphan entities/claims, try to match by ID prefix
  // Build a reverse lookup: bare article name → full article ID
  // e.g., "concept-aaak-compression" → "article:concepts/concept-aaak-compression"
  const bareToArticle = new Map();
  for (const nid of nodes.keys()) {
    if (nid.startsWith('article:')) bareToArticle.set(nid.includes('/') ? nid.split('/').at(-1) : nid.replaceAll('article:', ''), nid);
  }

  for (const [nid, node] of nodes) {
    if (!isChild(node.type) || childToArticle.has(nid)) continue;
    // e.g., "claim:concept-aaak-compression:not-zero-loss" → stem "concept-aaak-compression"
    // e.g., "entity:brain" → stem "brain"
    const raw = nid.includes(':') ? nid.slice(nid.indexOf(':') + 1) : nid;
    const stem = raw.split(':')[0];

    // Try exact bare name match first
    if (bareToArticle.has(stem)) {
      childToArticle.set(nid, bareToArticle.get(stem));
      continue;
    }
    // Try suffix/substring match against bare names
    // e.g., entity:brain → segment-brain, entity:mempalace → tool-mempalace
    let matched = false;
    for (const [bare, aid] of bareToArticle) {
      if (bare.includes(stem) || stem.includes(bare)) {
        childToArticle.set(nid, aid);
        matched = true;
        break;
      }
    }
    // Last resort: check if the node's name appears in any article's
    // name OR content (knowledgeMeta.content)
    if (matched || !truthy(get(node, 'name'))) continue;
    const nodeNameLower = node.name.toLowerCase();
    for (const [aid, anode] of nodes) {
      if (!aid.startsWith('article:')) continue;
      // Match against article name
      if (get(anode, 'name', '').toLowerCase().includes(nodeNameLower)) {
        childToArticle.set(nid, aid);
        break;
      }
      // Match against article content (wikilinks or text)
      const content = get(get(anode, 'knowledgeMeta', {}), 'content');
      if ([...nodeNameLower].length >= 3 && (truthy(content) ? content : '').toLowerCase().includes(nodeNameLower)) {
        childToArticle.set(nid, aid);
        break;
      }
    }
  }

  // Step 3: Place children into their parent article's layer
  for (const [childId, articleId] of childToArticle) {
    const layerId = articleLayerMap.get(articleId);
    if (layerId && layerMembers.has(layerId)) {
      layerMembers.get(layerId).push(childId);
      articleLayerMap.set(childId, layerId);
    }
  }

  // --- Build layers ---
  const layers = [];
  for (const cat of categories) {
    const layerId = `layer:${slug(cat.name)}`;
    const members = [...new Set(layerMembers.get(layerId) ?? [])]; // Deduplicate preserving order
    layers.push({ id: layerId, name: cat.name, description: `${cat.name} (${members.length} nodes)`, nodeIds: members });
  }

  // Assign uncategorized nodes to an "Other" layer
  const categorizedIds = new Set(layers.flatMap((layer) => layer.nodeIds));
  const uncategorized = [...nodes.keys()].filter((nid) => !categorizedIds.has(nid));
  if (uncategorized.length) {
    layers.push({ id: 'layer:other', name: 'Other', description: `Uncategorized nodes (${uncategorized.length})`, nodeIds: uncategorized });
  }

  // --- Build tour from index.md category ordering ---
  const tour = [];
  categories.forEach((cat, i) => {
    const topicId = `topic:${slug(cat.name)}`;
    // Pick representative articles (up to 3 per category)
    let members = categorizedUnder(topicId).slice(0, 3);
    if (!members.length && nodes.has(topicId)) members = [topicId];
    if (members.length) {
      tour.push({ order: i + 1, title: cat.name, description: `Explore the ${cat.name} section (${pyStr(cat.count)} articles)`, nodeIds: members });
    }
  });

  // --- Detect project name ---
  let projectName = basename(root);
  // Try to find a better name from index.md H1 (case-insensitively —
  // Index.md is a reasonable convention; exact lowercase wins if both exist)
  let indexPath = findMarkdownCaseInsensitive(join(root, 'wiki'), 'index.md');
  if (!isFile(indexPath)) indexPath = findMarkdownCaseInsensitive(root, 'index.md');
  if (isFile(indexPath)) {
    const h1 = H1_RE.exec(readText(indexPath));
    if (h1) projectName = strip(h1[1]);
  }

  // --- Assemble final graph ---
  const graph = {
    version: '1.0.0',
    kind: 'knowledge',
    project: {
      name: projectName,
      languages: ['markdown'],
      frameworks: ['karpathy-wiki'],
      description: `Knowledge graph for ${projectName}`,
      analyzedAt: isoNow(),
      gitCommitHash: '',
    },
    nodes: [...nodes.values()],
    edges: finalEdges,
    layers,
    tour,
  };

  // Try to get git commit hash
  try {
    graph.project.gitCommitHash = strip(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {}

  // Write output
  const outPath = join(intermediate, 'assembled-graph.json');
  writeFileSync(outPath, ascii(dumps(graph)));

  // Report
  err(`[merge] Input: ${report.base_nodes} scan nodes, ${report.base_edges} scan edges, ${report.batches} analysis batches`);
  err(
    `[merge] Added: ${report.new_entities} entities, ${report.new_claims} claims, ${report.new_edges} edges ` +
      `(${report.deduped_entities} deduped entities, ${report.dropped_edges} dropped dangling edges)`,
  );
  err(`[merge] Output: ${graph.nodes.length} nodes, ${finalEdges.length} edges, ${layers.length} layers, ${tour.length} tour steps`);
  err(`[merge] Written: ${outPath}`);

  return graph;
}

function main() {
  if (process.argv.length < 3) {
    err('Usage: node merge-knowledge-graph.mjs <wiki-directory>');
    process.exit(1);
  }

  const root = pyResolve(process.argv[2]);
  if (!isDir(root)) {
    err(`Error: ${root} is not a directory`);
    process.exit(1);
  }

  merge(root);
}

main();
