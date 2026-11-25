#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { parseFileKey, parseDocument, applyScreenThumbnails } from "../core/figma/index.js";

const [, , dataDir, urlOrKey] = process.argv;
if (!dataDir || !urlOrKey) {
  console.error("usage: figma-scan.mjs <dataDir> <figmaUrlOrKey>");
  process.exit(1);
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const fileKey = parseFileKey(urlOrKey);
const project = readJson(join(dataDir, "project.json"), null);
if (project?.kind !== "design" || project.figmaFileKey !== fileKey) {
  console.error(`${dataDir} is not the design data folder of Figma file ${fileKey}: run data-dir.mjs --figma first`);
  process.exit(1);
}

const interDir = join(dataDir, "intermediate");
const rawDir = join(interDir, "figma");
const thumbDir = join(dataDir, "thumbnails");
const targetsPath = join(rawDir, "targets.json");
const pages = readJson(join(rawDir, "pages.json"), null);
if (!Array.isArray(pages) || pages.length === 0) {
  console.error(`missing ${join(rawDir, "pages.json")}: save the page list from get_metadata first`);
  process.exit(1);
}

const figmaId = (id) => String(id ?? "").trim().replace(/^(\d+)-(\d+)$/, "$1:$2");
const TYPES = {
  canvas: "CANVAS", page: "CANVAS", frame: "FRAME", symbol: "COMPONENT", component: "COMPONENT",
  "component-set": "COMPONENT_SET", componentset: "COMPONENT_SET", "state-group": "COMPONENT_SET",
  instance: "INSTANCE", section: "SECTION",
};
const ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (_, e) =>
  e[0] !== "#" ? ENTITIES[e.toLowerCase()] : String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1))));

function parseXml(text) {
  const root = { tag: "", attrs: {}, children: [] };
  const stack = [root];
  for (const [, close, tag, attrs, selfClose] of text.matchAll(/<(\/?)([A-Za-z][\w.:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g)) {
    if (close) {
      const at = stack.findLastIndex((el) => el.tag === tag.toLowerCase());
      if (at > 0) stack.length = at;
      continue;
    }
    const el = { tag: tag.toLowerCase(), attrs: {}, children: [] };
    for (const [, name, dq, sq] of attrs.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[name] = decode(dq ?? sq);
    stack.at(-1).children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root.children;
}

function toFigmaNode({ tag, attrs: a, children }) {
  const kind = String(a.type ?? tag).toLowerCase().replace(/_/g, "-");
  const node = { id: figmaId(a.id), name: a.name ?? "", type: TYPES[kind] ?? kind.toUpperCase().replace(/-/g, "_"), children: children.map(toFigmaNode) };
  const width = Number(a.width);
  const height = Number(a.height);
  if (a.width && a.height && Number.isFinite(width) && Number.isFinite(height)) node.absoluteBoundingBox = { width, height };
  if (a.componentId) node.componentId = figmaId(a.componentId);
  if (node.type === "FRAME" && node.children.length && node.children.every((c) => c.type === "COMPONENT" && c.name.includes("="))) node.type = "COMPONENT_SET";
  return node;
}

function pageChildren(pageId) {
  const file = join(rawDir, `page-${pageId.replace(/[^A-Za-z0-9_-]/g, "-")}.xml`);
  if (!existsSync(file)) {
    console.error(`[warning] no metadata for page ${pageId} (${file})`);
    return [];
  }
  let text = readFileSync(file, "utf8");
  if (/^\s*[[{]/.test(text)) {
    try {
      const j = JSON.parse(text);
      text = [j?.content ?? j].flat().map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("\n");
    } catch {}
  }
  const unwrap = (list) => list.flatMap((n) => (n.id ? [n] : unwrap(n.children)));
  const roots = unwrap(parseXml(text).map(toFigmaNode));
  const canvas = roots.find((n) => n.id === pageId || n.type === "CANVAS");
  return canvas ? canvas.children : roots;
}

const walk = (n, fn) => {
  fn(n);
  for (const c of n.children ?? []) walk(c, fn);
};
// ponytail: get_metadata has no main-component id, so instances link by name (a variant instance -> the set's first variant); renamed or library instances get no instance_of edge
function linkInstances(root) {
  const byName = new Map();
  walk(root, (n) => {
    const target = n.type === "COMPONENT_SET" ? n.children.find((c) => c.type === "COMPONENT")?.id : n.type === "COMPONENT" ? n.id : undefined;
    if (target && !byName.has(n.name)) byName.set(n.name, target);
  });
  walk(root, (n) => {
    if (n.type === "INSTANCE" && !n.componentId && byName.has(n.name)) n.componentId = byName.get(n.name);
  });
}

const doc = {
  name: project.figmaFileName || fileKey,
  document: { children: pages.map((p) => ({ id: figmaId(p.id), name: String(p.name ?? p.id), type: "CANVAS", children: pageChildren(figmaId(p.id)) })) },
};
linkInstances(doc.document);

const structural = parseDocument(doc, fileKey);
const figmaVersion = createHash("sha1").update(JSON.stringify(structural)).digest("hex").slice(0, 16);
const firstPass = !existsSync(targetsPath);
const prevVersion = readJson(join(dataDir, "meta.json"), null)?.figmaVersion ?? null;
if (firstPass && prevVersion === figmaVersion && process.env.UNDERSTAND_FIGMA_FORCE !== "1") {
  console.error("UP_TO_DATE");
  process.exit(0);
}

const safeId = (id) => id.replace(/[^A-Za-z0-9._-]/g, "-");
const screens = structural.nodes.filter((n) => n.type === "screen");
const variants = new Set(structural.edges.filter((e) => e.type === "variant_of").map((e) => e.source));
if (firstPass) rmSync(thumbDir, { recursive: true, force: true });
mkdirSync(thumbDir, { recursive: true });
const targets = {
  variableDefs: structural.nodes
    .filter((n) => n.type === "screen" || n.type === "componentSet" || (n.type === "component" && !variants.has(n.id)))
    .map((n) => n.figmaMeta.nodeId),
  screenshots: screens.map((n) => ({ nodeId: n.figmaMeta.nodeId, file: join(thumbDir, `${safeId(n.id)}.png`) })),
};
writeFileSync(targetsPath, JSON.stringify(targets, null, 2));

const tokenKind = (v) =>
  /^(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()/i.test(v) ? "color"
  : /^font\(/i.test(v) ? "type"
  : /^effect\(/i.test(v) ? "effect"
  : /^(layout)?grid\(/i.test(v) ? "grid"
  : /^-?\d+(\.\d+)?(px|rem|em|%)?$/i.test(v) ? "spacing"
  : null;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const graphIdByFigmaId = new Map(structural.nodes.map((n) => [n.figmaMeta.nodeId, n.id]));
const tokens = new Map();
const tokenEdges = [];
const usesSeen = new Set();
for (const [nodeId, defs] of Object.entries(readJson(join(rawDir, "vars.json"), {}) ?? {})) {
  const consumerId = graphIdByFigmaId.get(figmaId(nodeId));
  for (const [name, raw] of Object.entries(defs ?? {})) {
    const value = String(raw).trim();
    const kind = tokenKind(value);
    if (!kind) continue;
    const id = `token:${kind}:${slug(name) || name}`;
    if (!tokens.has(id)) {
      tokens.set(id, { id, type: "token", name, summary: name, tags: ["token", kind], complexity: "simple", figmaMeta: { fileKey, tokenKind: kind, tokenValue: value } });
    }
    if (consumerId && !usesSeen.has(`${consumerId}|${id}`)) {
      usesSeen.add(`${consumerId}|${id}`);
      tokenEdges.push({ source: consumerId, target: id, type: "uses_token", direction: "forward", weight: 0.5 });
    }
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const images = {};
for (const { nodeId, file } of targets.screenshots) {
  if (!existsSync(file)) continue;
  if (readFileSync(file).subarray(0, 8).equals(PNG)) {
    images[nodeId] = `/api/understand/thumb?project=${encodeURIComponent(project.key ?? basename(dataDir))}&id=${encodeURIComponent(basename(file, ".png"))}`;
  } else rmSync(file, { force: true });
}
applyScreenThumbnails(structural.nodes, images);

const nodes = [...structural.nodes, ...tokens.values()];
const edges = [...structural.edges, ...tokenEdges];

const manifest = {
  project: {
    name: doc.name,
    languages: ["figma"],
    frameworks: [],
    description: `Figma design file: ${doc.name}`,
    analyzedAt: new Date().toISOString(),
    gitCommitHash: "",
  },
  fileKey,
  figmaVersion,
  nodes,
  edges,
};

mkdirSync(interDir, { recursive: true });
writeFileSync(join(interDir, "scan-manifest.json"), JSON.stringify(manifest, null, 2));

const byId = new Map(nodes.map((n) => [n.id, n]));
const parent = new Map();
const children = new Map();
const tokensOf = new Map();
const push = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v);
for (const e of edges) {
  if (e.type === "contains") {
    parent.set(e.target, e.source);
    push(children, e.source, e.target);
  } else if (e.type === "variant_of") {
    parent.set(e.source, e.target);
    push(children, e.target, e.source);
  } else if (e.type === "uses_token") push(tokensOf, e.source, e.target);
}
const pageOf = (id) => {
  for (let cur = id, seen = new Set(); cur && !seen.has(cur); cur = parent.get(cur)) {
    seen.add(cur);
    if (byId.get(cur)?.type === "page") return cur;
  }
  return "";
};
const groups = new Map();
for (const n of nodes) {
  push(groups, pageOf(n.id), {
    id: n.id,
    type: n.type,
    name: n.name,
    figmaMeta: n.figmaMeta,
    childSummary: [...new Set((children.get(n.id) ?? []).map((c) => byId.get(c)?.name))].slice(0, 20),
    tokenUsage: (tokensOf.get(n.id) ?? []).map((t) => byId.get(t)?.name),
  });
}
const batches = [...groups.values()].flatMap((g) => Array.from({ length: Math.ceil(g.length / 15) }, (_, i) => g.slice(i * 15, i * 15 + 15)));
writeFileSync(join(interDir, "design-batches.json"), JSON.stringify({ nodeIds: nodes.map((n) => n.id), batches }, null, 2));

const count = (t) => nodes.filter((n) => n.type === t).length;
console.error(
  `Figma scan: ${count("page")} pages, ${count("screen")} screens, ` +
  `${count("component")} components, ${count("componentSet")} sets, ` +
  `${count("instance")} instances, ${count("token")} tokens`,
);
console.error(`Thumbnails: ${Object.keys(images).length}/${screens.length} screens. Analysis batches: ${batches.length}`);
if (firstPass) {
  console.error(`Next: get_variable_defs for ${targets.variableDefs.length} nodes, get_screenshot for ${screens.length} screens (${targetsPath})`);
}
