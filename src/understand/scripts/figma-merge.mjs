#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mergeDesignGraph } from "../core/figma/index.js";

const [, , dataDir] = process.argv;
let project = null;
try {
  project = JSON.parse(readFileSync(join(dataDir, "project.json"), "utf8"));
} catch {}
if (project?.kind !== "design") {
  console.error("usage: figma-merge.mjs <dataDir> (a design data folder made by data-dir.mjs --figma)");
  process.exit(1);
}

const interDir = join(dataDir, "intermediate");
const manifest = JSON.parse(readFileSync(join(interDir, "scan-manifest.json"), "utf8"));
const analyses = readdirSync(interDir)
  .filter((f) => /^analysis-batch-.*\.json$/.test(f))
  .flatMap((f) => {
    try {
      return [JSON.parse(readFileSync(join(interDir, f), "utf8"))];
    } catch {
      console.error(`[warning] skipped ${f}: not valid JSON`);
      return [];
    }
  });

const result = mergeDesignGraph(
  { nodes: manifest.nodes, edges: manifest.edges },
  analyses,
  manifest.project,
);
if (!result.success || !result.data) {
  console.error("Merge failed:", result.fatal ?? "unknown error");
  process.exit(1);
}

writeFileSync(join(dataDir, "knowledge-graph.json"), JSON.stringify(result.data, null, 2));
writeFileSync(join(dataDir, "meta.json"), JSON.stringify({
  lastAnalyzedAt: new Date().toISOString(),
  gitCommitHash: "",
  figmaVersion: manifest.figmaVersion ?? "",
  version: "1.0.0",
  analyzedFiles: result.data.nodes.length,
}, null, 2));

console.error(
  `Design graph: ${result.data.nodes.length} nodes, ${result.data.edges.length} edges, ` +
  `${result.data.layers.length} layers, ${result.data.tour.length} tour steps`,
);
for (const issue of result.issues) {
  if (issue.level !== "auto-corrected") console.error(`[${issue.level}] ${issue.message}`);
}
