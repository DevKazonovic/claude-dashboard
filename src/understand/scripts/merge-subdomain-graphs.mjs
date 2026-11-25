#!/usr/bin/env node
/**
 * merge-subdomain-graphs.mjs — Merge subdomain knowledge-graph files into one.
 *
 * Auto-discovers *knowledge-graph*.json files in the project's data dir
 * (resolveUaDir) excluding knowledge-graph.json itself, loads the existing
 * knowledge-graph.json as a base if present, and merges everything
 * into a single knowledge-graph.json.
 *
 * Usage:
 *     node merge-subdomain-graphs.mjs <project-root> [file1.json file2.json ...]
 *
 * If no files are specified, auto-discovers subdomain graphs. The main
 * knowledge-graph.json is loaded as a base but never as a discovery input
 * (prevents self-merging on repeated runs).
 *
 * Output:
 *     <ua-dir>/knowledge-graph.json
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveUaDir } from '../core/index.js';
import {
  Counter, PyError, dumps, err, get, has, isDict, isDir, kb, loadJson, num, pad, pyContains, pyEq, pyIter, pyKey, pyLen,
  pyResolve, pyStr, pyType, truthy, writeText,
} from './merge-batch-graphs.mjs';

// Edge types that carry the domain hierarchy. Dropping one of these changes
// downstream graph traversal (unlike a routine `related` edge), so they are
// warned about loudly and re-tried on later runs via merge-report.json —
// subdomain graph files are cleaned up after assembly, so a drop would
// otherwise be permanent even once the missing endpoint's subdomain arrives.
const STRUCTURAL_EDGE_TYPES = new Set(['contains_flow', 'flow_step', 'cross_domain']);

const edgeKey = (e) => JSON.stringify([pyKey(get(e, 'source', '')), pyKey(get(e, 'target', '')), pyKey(get(e, 'type', ''))]);

/** Load and minimally validate a knowledge graph JSON file. */
function loadGraph(path) {
  let data;
  try {
    data = loadJson(path);
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
    err(`  Skipping ${basename(path)}: ${e.message}`);
    return null;
  }

  // Must have at minimum nodes and edges arrays
  if (!Array.isArray(get(data, 'nodes')) || !Array.isArray(get(data, 'edges'))) {
    err(`  Skipping ${basename(path)}: missing nodes or edges array`);
    return null;
  }

  return data;
}

/**
 * Merge multiple knowledge graph dicts into one.
 *
 * Returns [merged, reportLines, droppedEdges] — droppedEdges holds the
 * full edge dicts that were removed for missing endpoints, each with an
 * extra "missing" key naming which endpoint(s) were absent.
 */
function mergeGraphs(graphs) {
  // ── Pattern counters for "Fixed" report ──────────────────────────
  const nodeDedupByType = new Counter();

  // ── Detail lists for "Could not fix" report ──────────────────────
  const unfixable = [];

  let totalInputNodes = 0;
  let totalInputEdges = 0;
  for (const g of graphs) {
    totalInputNodes += pyLen(get(g, 'nodes', []));
    totalInputEdges += pyLen(get(g, 'edges', []));
  }

  // ── Nodes: deduplicate by id, later occurrence wins ───────────────
  const nodesById = new Map();
  for (const g of graphs) {
    for (const node of get(g, 'nodes', [])) {
      const nid = get(node, 'id');
      if (!truthy(nid)) {
        unfixable.push(`Node with no 'id' (name=${pyStr(get(node, 'name', '?'))}, type=${pyStr(get(node, 'type', '?'))})`);
        continue;
      }
      const k = pyKey(nid);
      if (nodesById.has(k)) nodeDedupByType.add(get(node, 'type', '?'));
      nodesById.set(k, node);
    }
  }

  // ── Edges: deduplicate by (source, target, type), higher weight wins
  let edgeDedupCount = 0;
  const edgesByKey = new Map();
  for (const g of graphs) {
    for (const edge of get(g, 'edges', [])) {
      const key = edgeKey(edge);
      const existing = edgesByKey.get(key);
      if (existing === undefined) {
        edgesByKey.set(key, edge);
      } else {
        edgeDedupCount += 1;
        if (num(get(edge, 'weight', 0)) > num(get(existing, 'weight', 0))) edgesByKey.set(key, edge);
      }
    }
  }

  // Drop edges referencing missing nodes
  const validEdges = [];
  const droppedEdges = [];
  const structuralWarnings = [];
  for (const e of edgesByKey.values()) {
    const src = get(e, 'source', '');
    const tgt = get(e, 'target', '');
    const srcKnown = nodesById.has(pyKey(src));
    const tgtKnown = nodesById.has(pyKey(tgt));
    if (srcKnown && tgtKnown) {
      validEdges.push(e);
      continue;
    }
    const missing = [];
    if (!srcKnown) missing.push(`source '${pyStr(src)}'`);
    if (!tgtKnown) missing.push(`target '${pyStr(tgt)}'`);
    const etype = get(e, 'type', '?');
    droppedEdges.push({ ...e, missing });
    if (has(STRUCTURAL_EDGE_TYPES, etype)) {
      structuralWarnings.push(`Warning: dropped structural edge ${pyStr(src)} → ${pyStr(tgt)} (${pyStr(etype)}), missing ${missing.join(', ')} — will retry on the next merge run`);
    } else {
      unfixable.push(`Edge ${pyStr(src)} → ${pyStr(tgt)} (${pyStr(etype)}): dropped, missing ${missing.join(', ')}`);
    }
  }

  // ── Layers: merge by id, union nodeIds ────────────────────────────
  const layersById = new Map();
  for (const g of graphs) {
    for (const layer of pyIter(get(g, 'layers', []))) {
      const lid = pyKey(get(layer, 'id', ''));
      if (layersById.has(lid)) {
        const target = layersById.get(lid);
        const ids = new Map();
        for (const nid of [...pyIter(get(target, 'nodeIds', [])), ...pyIter(get(layer, 'nodeIds', []))]) {
          if (!ids.has(pyKey(nid))) ids.set(pyKey(nid), nid);
        }
        // ponytail: Python's list(set(...)) order is hash-seeded random; first-seen order here is deterministic
        target.nodeIds = [...ids.values()];
      } else {
        layersById.set(lid, { ...layer });
      }
    }
  }

  // Drop dangling layer nodeIds
  let droppedLayerRefs = 0;
  for (const layer of layersById.values()) {
    const before = pyLen(get(layer, 'nodeIds', []));
    layer.nodeIds = pyIter(get(layer, 'nodeIds', [])).filter((nid) => nodesById.has(pyKey(nid)));
    const diff = before - layer.nodeIds.length;
    if (diff) droppedLayerRefs += diff;
  }

  // ── Tour: concatenate, merge steps with same title ─────────────────
  const allTourSteps = [];
  const titleToStep = new Map();
  for (const g of graphs) {
    for (const step of pyIter(get(g, 'tour', []))) {
      const title = pyKey(get(step, 'title', ''));
      if (titleToStep.has(title)) {
        // Merge nodeIds from duplicate-titled steps (e.g. both
        // subdomains produce a "Project Overview" step 1)
        const existing = titleToStep.get(title);
        for (const nid of pyIter(get(step, 'nodeIds', []))) {
          if (!pyContains(get(existing, 'nodeIds', []), nid)) {
            if (!Object.hasOwn(existing, 'nodeIds')) existing.nodeIds = [];
            if (!Array.isArray(existing.nodeIds)) throw new TypeError(`'${pyType(existing.nodeIds)}' object has no attribute 'append'`);
            existing.nodeIds.push(nid);
          }
        }
        // Keep the longer description
        if (pyLen(get(step, 'description', '')) > pyLen(get(existing, 'description', ''))) existing.description = step.description;
      } else {
        const newStep = { ...step };
        titleToStep.set(title, newStep);
        allTourSteps.push(newStep);
      }
    }
  }

  // Drop dangling tour nodeIds and re-number
  let droppedTourRefs = 0;
  allTourSteps.forEach((step, i) => {
    step.order = i + 1;
    const before = pyLen(get(step, 'nodeIds', []));
    step.nodeIds = pyIter(get(step, 'nodeIds', [])).filter((nid) => nodesById.has(pyKey(nid)));
    const diff = before - step.nodeIds.length;
    if (diff) droppedTourRefs += diff;
  });

  // ── Project metadata: merge ───────────────────────────────────────
  const languages = [];
  const frameworks = [];
  const descriptions = [];
  let latestAt = '';
  let latestHash = '';
  let projectName = '';

  for (const g of graphs) {
    const proj = get(g, 'project', {});
    const name = get(proj, 'name', '');
    projectName = truthy(name) ? name : projectName;
    for (const lang of pyIter(get(proj, 'languages', []))) if (!languages.some((x) => pyEq(x, lang))) languages.push(lang);
    for (const fw of pyIter(get(proj, 'frameworks', []))) if (!frameworks.some((x) => pyEq(x, fw))) frameworks.push(fw);
    const desc = get(proj, 'description', '');
    if (truthy(desc) && !descriptions.some((x) => pyEq(x, desc))) descriptions.push(desc);
    const analyzed = get(proj, 'analyzedAt', '');
    if (typeof analyzed !== 'string') throw new TypeError(`'>' not supported between instances of '${pyType(analyzed)}' and 'str'`);
    if (analyzed > latestAt) {
      latestAt = analyzed;
      latestHash = get(proj, 'gitCommitHash', latestHash);
    }
  }

  // ── Build report ─────────────────────────────────────────────────
  const report = [`Input: ${totalInputNodes} nodes, ${totalInputEdges} edges (from ${graphs.length} graphs)`];

  // Fixed section
  const fixedLines = [];
  for (const [ntype, count] of nodeDedupByType.mostCommon()) fixedLines.push(`  ${pad(count)} × duplicate '${pyStr(ntype)}' nodes removed (kept later)`);
  if (edgeDedupCount) fixedLines.push(`  ${pad(edgeDedupCount)} × duplicate edges removed (kept higher weight)`);
  if (droppedLayerRefs) fixedLines.push(`  ${pad(droppedLayerRefs)} × dangling layer nodeId refs removed`);
  if (droppedTourRefs) fixedLines.push(`  ${pad(droppedTourRefs)} × dangling tour nodeId refs removed`);

  if (fixedLines.length) {
    const totalFixed = nodeDedupByType.total() + edgeDedupCount + droppedLayerRefs + droppedTourRefs;
    report.push('', `Fixed (${totalFixed} corrections):`, ...fixedLines);
  }

  // Structural drops surface as loud warnings, not buried counters —
  // losing hierarchy/cross-domain edges changes downstream traversal.
  if (structuralWarnings.length) report.push('', ...structuralWarnings);

  // Could not fix section
  if (unfixable.length) {
    report.push('', `Could not fix (${unfixable.length} issues — needs agent review):`);
    for (const detail of unfixable) report.push(`  - ${detail}`);
  }

  // Output stats
  report.push('', `Output: ${nodesById.size} nodes, ${validEdges.length} edges, ${layersById.size} layers, ${allTourSteps.length} tour steps`);

  let description = '';
  if (descriptions.length > 1) {
    const bad = descriptions.findIndex((d) => typeof d !== 'string');
    if (bad !== -1) throw new TypeError(`sequence item ${bad}: expected str instance, ${pyType(descriptions[bad])} found`);
    description = descriptions.join(' | ');
  } else if (descriptions.length) {
    description = descriptions[0];
  }

  const merged = {
    version: '1.0.0',
    project: {
      name: projectName,
      languages,
      frameworks,
      description,
      analyzedAt: latestAt,
      gitCommitHash: latestHash,
    },
    nodes: [...nodesById.values()],
    edges: validEdges,
    layers: [...layersById.values()],
    tour: allTourSteps,
  };

  return [merged, report, droppedEdges];
}

/**
 * Read structural edges dropped by a previous run from merge-report.json.
 *
 * Subdomain graph files are cleaned up after assembly, so these edges only
 * survive in the report — re-injecting them lets a later run resolve them
 * once the missing endpoint's subdomain graph has been merged.
 */
function loadPendingStructuralEdges(reportPath) {
  if (!existsSync(reportPath)) return [];
  let data;
  try {
    data = loadJson(reportPath);
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
    err(`Warning: could not read ${basename(reportPath)}: ${e.message}`);
    return [];
  }
  const pending = [];
  for (const entry of pyIter(get(data, 'droppedEdges', []))) {
    if (isDict(entry) && has(STRUCTURAL_EDGE_TYPES, get(entry, 'type'))) {
      const copy = { ...entry };
      delete copy.missing;
      pending.push(copy);
    }
  }
  return pending;
}

/** Persist the dropped-edge report so investigations don't require re-instrumenting the script. */
function writeMergeReport(reportPath, merged, droppedEdges, recoveredCount) {
  const report = {
    generatedBy: 'merge-subdomain-graphs.py',
    output: {
      nodes: merged.nodes.length,
      edges: merged.edges.length,
      layers: merged.layers.length,
      tourSteps: merged.tour.length,
    },
    recoveredStructuralEdges: recoveredCount,
    droppedEdges,
  };
  writeText(reportPath, dumps(report));
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    err('Usage: node merge-subdomain-graphs.mjs <project-root> [file1.json file2.json ...]');
    process.exit(1);
  }

  const projectRoot = pyResolve(argv[0]);
  const uaDir = resolveUaDir(projectRoot);

  if (!isDir(uaDir)) {
    err(`Error: ${uaDir} does not exist`);
    process.exit(1);
  }

  const outputPath = join(uaDir, 'knowledge-graph.json');

  // Determine which files to merge: an explicit file list, or auto-discovered
  // subdomain graphs — excluding the main output file to avoid self-merging
  // on repeated runs
  const graphFiles = argv.length > 1
    ? argv.slice(1).map(pyResolve)
    : readdirSync(uaDir)
      .filter((name) => /^[\s\S]*knowledge-graph[\s\S]*\.json$/.test(name) && name !== 'knowledge-graph.json')
      .sort()
      .map((name) => join(uaDir, name));

  if (!graphFiles.length) {
    err('No subdomain graphs found to merge');
    process.exit(0);
  }

  err(`Found ${graphFiles.length} subdomain graphs:`);
  for (const f of graphFiles) err(`  - ${basename(f)}`);

  // Load subdomain graphs
  const graphs = [];
  for (const f of graphFiles) {
    const g = loadGraph(f);
    if (g !== null) {
      graphs.push(g);
      err(`    Loaded ${basename(f)}: ${g.nodes.length} nodes, ${g.edges.length} edges`);
    }
  }

  if (!graphs.length) {
    err('Error: no valid subdomain graphs loaded');
    process.exit(1);
  }

  // Load the existing main graph as base (if it exists)
  if (existsSync(outputPath)) {
    const base = loadGraph(outputPath);
    if (base) {
      err(`    Loaded base knowledge-graph.json: ${base.nodes.length} nodes, ${base.edges.length} edges`);
      graphs.unshift(base); // Base first — subdomain data wins on conflict
    }
  }

  // Re-inject structural edges a previous run had to drop; if their missing
  // endpoints have arrived in the meantime, this run resolves them.
  const reportPath = join(uaDir, 'merge-report.json');
  const pendingEdges = loadPendingStructuralEdges(reportPath);
  if (pendingEdges.length) {
    err(`    Retrying ${pendingEdges.length} structural edges dropped by a previous run`);
    graphs.push({ nodes: [], edges: pendingEdges });
  }

  // Merge
  const [merged, report, droppedEdges] = mergeGraphs(graphs);

  // Print report
  err('');
  for (const line of report) err(line);

  // Count how many previously-dropped structural edges made it in this time
  const mergedEdgeKeys = new Set(merged.edges.map(edgeKey));
  const recovered = pendingEdges.filter((e) => mergedEdgeKeys.has(edgeKey(e))).length;
  if (recovered) err(`Recovered ${recovered} structural edges dropped by a previous run`);

  // Write output
  writeText(outputPath, dumps(merged));
  writeMergeReport(reportPath, merged, droppedEdges, recovered);
  err(`Merge report written to ${reportPath}`);

  err(`\nWritten to ${outputPath} (${kb(outputPath)} KB)`);
}

if (import.meta.main) main();
