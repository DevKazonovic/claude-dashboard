#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  loadGraph,
  loadConfig,
  resolveUaDir,
  getGraphFreshnessBatch,
} from "../core/index.js";
import {
  buildChatContext,
  formatContextForPrompt,
  buildDiffContext,
  formatDiffAnalysis,
  buildExplainContext,
  formatExplainPrompt,
  buildOnboardingGuide,
} from "./lib/context-builders.mjs";
import { changedFiles } from "./lib/changed-files.mjs";
import { DATA_ROOT, findDataDir } from "./lib/find-data-dir.mjs";

console.log = console.info = console.debug = console.error;

const CLI = fileURLToPath(new URL("../../../bin/claude-dashboard.js", import.meta.url));
const { version: SERVER_VERSION } = JSON.parse(
  fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
);
const PROTOCOL_VERSION = "2025-06-18";
const DASHBOARD_TIMEOUT_MS = 20_000;
const execFileAsync = promisify(execFile);

const INSTRUCTIONS = [
  "Understand Anything tools answer questions about a codebase using its",
  "knowledge graph (~/.claude/understand/<project>/knowledge-graph.json). Typical flow:",
  "1. understand_status: check a graph exists and whether it is fresh.",
  "2. understand_search / understand_explain / understand_diff /",
  "   understand_onboard: pull focused context for the task at hand.",
  "3. understand_dashboard: when the user wants the visual graph UI.",
  "If no graph exists, tell the user to run /understand on the project first.",
].join(" ");

function resolveProjectRoot(projectPath) {
  const raw = projectPath ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Project directory not found: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(message) {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

function noGraph(where) {
  return new Error(
    `No knowledge graph found ${where}.\n` +
      "Run /understand on this project first, then call this tool again.",
  );
}

function openGraph(projectPath) {
  const root = resolveProjectRoot(projectPath);
  if (!findDataDir(root)) throw noGraph(`for ${root} in ${DATA_ROOT}`);
  let graph;
  try {
    graph = loadGraph(root);
  } catch (err) {
    throw new Error(`Failed to load knowledge graph for ${root}: ${err.message}`);
  }
  if (!graph) throw noGraph(`at ${path.join(resolveUaDir(root), "knowledge-graph.json")}`);
  return { root, graph };
}

async function freshnessSummary(root, graph) {
  try {
    const results = await getGraphFreshnessBatch(root, {
      knowledge: {
        graphCommitHash: graph.project.gitCommitHash,
        lastAnalyzedAt: graph.project.analyzedAt,
      },
    });
    const r = results.knowledge;
    if (r.status === "fresh") return "fresh";
    if (r.status === "dirty" || r.status === "stale") {
      const files = r.changedFiles.slice(0, 10);
      const more =
        r.changedFileCount > files.length
          ? ` (+${r.changedFileCount - files.length} more)`
          : "";
      const label =
        r.status === "dirty"
          ? "uncommitted change(s) since analysis"
          : "project file(s) changed since analysis";
      return (
        `${r.status}, ${r.changedFileCount} ${label}` +
        (files.length ? `: ${files.join(", ")}${more}` : "")
      );
    }
    return `unknown (${r.reason ?? "git metadata unavailable"})`;
  } catch {
    return "unknown (freshness check failed)";
  }
}

async function stalenessWarning(root, graph) {
  const summary = await freshnessSummary(root, graph);
  if (summary === "fresh") return "";
  return (
    `> **Graph freshness: ${summary}.** ` +
    "Graph-derived context may omit recent changes. " +
    "Re-run /understand to refresh.\n\n"
  );
}

async function runningDashboard(portArgs) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, "status", ...portArgs], {
    timeout: 10_000,
  });
  return stdout.match(/Running at (http:\/\/\S+)/)?.[1] ?? null;
}

async function ensureDashboard(port) {
  const portArgs = port ? ["--port", String(port)] : [];
  let url = await runningDashboard(portArgs);
  if (url) return url;
  spawn(process.execPath, [CLI, "start", "--no-open", ...portArgs], {
    detached: true,
    stdio: "ignore",
  }).unref();
  const deadline = Date.now() + DASHBOARD_TIMEOUT_MS;
  while (!(url = await runningDashboard(portArgs))) {
    if (Date.now() > deadline) {
      throw new Error(
        `claude-dashboard did not start within ${DASHBOARD_TIMEOUT_MS / 1000}s. ` +
          `Run node ${CLI} start --no-open to see why.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return url;
}

const projectPathParam = z
  .string()
  .optional()
  .describe(
    "Project directory. Defaults to CLAUDE_PROJECT_DIR or the server's working directory.",
  );

const tools = [
  {
    name: "understand_status",
    title: "Understand Anything: status",
    description:
      "Check whether a knowledge graph exists for a project, show its metadata " +
      "(name, description, languages, frameworks, analyzed commit), node/edge counts, " +
      "and whether it is stale relative to the current git state.",
    schema: z.object({ projectPath: projectPathParam }),
    annotations: { readOnlyHint: true },
    async run({ projectPath }) {
      const { root, graph } = openGraph(projectPath);
      const config = loadConfig(root);
      const freshness = await freshnessSummary(root, graph);
      const counts = graph.nodes.reduce((acc, n) => {
        acc[n.type] = (acc[n.type] ?? 0) + 1;
        return acc;
      }, {});
      return textResult(
        [
          `# Understand Anything status: ${graph.project.name}`,
          "",
          `- **Project root:** ${root}`,
          `- **Graph:** ${path.join(resolveUaDir(root), "knowledge-graph.json")}`,
          `- **Description:** ${graph.project.description}`,
          `- **Languages:** ${graph.project.languages.join(", ") || "none"}`,
          `- **Frameworks:** ${graph.project.frameworks.join(", ") || "none"}`,
          `- **Analyzed at:** ${graph.project.analyzedAt} (commit ${graph.project.gitCommitHash || "?"})`,
          `- **Freshness:** ${freshness}`,
          `- **Size:** ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.layers.length} layers, ${graph.tour.length} tour steps`,
          `- **Node types:** ${Object.entries(counts).map(([t, c]) => `${t}: ${c}`).join(", ")}`,
          `- **Config:** autoUpdate=${config.autoUpdate}, outputLanguage=${config.outputLanguage}`,
        ].join("\n"),
      );
    },
  },
  {
    name: "understand_search",
    title: "Understand Anything: search",
    description:
      "Search the project's knowledge graph for components relevant to a query " +
      "(names, summaries, tags), expanded to 1-hop neighbours with layers and " +
      "relationships. Returns markdown context for answering codebase questions.",
    schema: z.object({
      projectPath: projectPathParam,
      query: z
        .string()
        .min(1)
        .describe("What to look for, e.g. 'authentication flow' or 'database schema'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max seed nodes to match before 1-hop expansion (default 15)."),
    }),
    annotations: { readOnlyHint: true },
    async run({ projectPath, query, limit }) {
      const { root, graph } = openGraph(projectPath);
      const context = buildChatContext(graph, query, limit);
      const warning = await stalenessWarning(root, graph);
      return textResult(warning + formatContextForPrompt(context));
    },
  },
  {
    name: "understand_explain",
    title: "Understand Anything: explain",
    description:
      "Deep-dive on one component: a file path ('src/auth.ts') or a specific " +
      "function ('src/auth.ts:login'). Returns its summary, complexity, layer, " +
      "children, connections, and relationships from the knowledge graph.",
    schema: z.object({
      projectPath: projectPathParam,
      path: z
        .string()
        .min(1)
        .describe("Project-relative file path, optionally suffixed with :functionName."),
    }),
    annotations: { readOnlyHint: true },
    async run({ projectPath, path: target }) {
      const { root, graph } = openGraph(projectPath);
      const context = buildExplainContext(graph, target);
      const warning = await stalenessWarning(root, graph);
      return textResult(warning + formatExplainPrompt(context));
    },
  },
  {
    name: "understand_diff",
    title: "Understand Anything: diff impact",
    description:
      "Map the current git changes onto the knowledge graph: which components " +
      "changed, what they affect downstream, impacted layers, and a risk " +
      "assessment. Defaults to working tree + staged + untracked changes; pass staged=true " +
      "for the index only, or base='<ref>' to diff a ref against HEAD.",
    schema: z.object({
      projectPath: projectPathParam,
      staged: z
        .boolean()
        .optional()
        .describe("Analyze staged changes only (default: working tree + staged + untracked)."),
      base: z
        .string()
        .optional()
        .describe("Git ref to compare against HEAD, e.g. 'main' or 'HEAD~3'."),
    }),
    annotations: { readOnlyHint: true },
    async run({ projectPath, staged, base }) {
      const { root, graph } = openGraph(projectPath);
      let files;
      try {
        files = changedFiles(root, { staged, base });
      } catch (err) {
        return errorResult(`Could not compute git changes in ${root}: ${err.message}`);
      }
      if (files.length === 0) {
        const scope = base
          ? `between ${base} and HEAD`
          : staged
            ? "in the index"
            : "in the working tree, index, or untracked files";
        return textResult(`No changed files found ${scope} for this project.`);
      }
      const context = buildDiffContext(graph, files);
      const warning = await stalenessWarning(root, graph);
      return textResult(warning + formatDiffAnalysis(context));
    },
  },
  {
    name: "understand_onboard",
    title: "Understand Anything: onboarding guide",
    description:
      "Generate a standalone markdown onboarding guide from the knowledge graph: " +
      "project overview, architectural layers, key concepts, guided tour, file map, " +
      "and complexity hotspots.",
    schema: z.object({ projectPath: projectPathParam }),
    annotations: { readOnlyHint: true },
    async run({ projectPath }) {
      const { root, graph } = openGraph(projectPath);
      const warning = await stalenessWarning(root, graph);
      return textResult(warning + buildOnboardingGuide(graph));
    },
  },
  {
    name: "understand_dashboard",
    title: "Understand Anything: dashboard",
    description:
      "Open the project's knowledge graph on the Understand page of claude-dashboard " +
      "and return its URL. Starts claude-dashboard in the background when it is not " +
      "running; it keeps running after this session. Share the full URL with the user.",
    schema: z.object({
      projectPath: projectPathParam,
      port: z
        .number()
        .int()
        .min(0)
        .max(65535)
        .optional()
        .describe("Port claude-dashboard listens on, on 127.0.0.1 (default 3737)."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run({ projectPath, port }) {
      const { root } = openGraph(projectPath);
      const dataDir = resolveUaDir(root);
      const url = await ensureDashboard(port);
      return textResult(
        [
          `Dashboard is running at ${url}/understand?project=${encodeURIComponent(path.basename(dataDir))}`,
          `Viewing: ${path.join(dataDir, "knowledge-graph.json")}`,
          "",
          "claude-dashboard keeps running in the background, and the page reloads by itself",
          "when the graph changes.",
        ].join("\n"),
      );
    },
  },
];

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const methods = {
  initialize: (params) => ({
    protocolVersion:
      typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "understand-anything", version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
  }),
  ping: () => ({}),
  "tools/list": () => ({
    tools: tools.map(({ name, title, description, schema, annotations }) => ({
      name,
      title,
      description,
      inputSchema: z.toJSONSchema(schema, { io: "input" }),
      annotations,
    })),
  }),
  "tools/call": async (params) => {
    const tool = tools.find((t) => t.name === params?.name);
    if (!tool) throw new RpcError(-32602, `Tool ${params?.name} not found`);
    const parsed = tool.schema.safeParse(params.arguments ?? {});
    if (!parsed.success) {
      return errorResult(
        `Invalid arguments for tool ${tool.name}:\n${z.prettifyError(parsed.error)}`,
      );
    }
    try {
      return await tool.run(parsed.data);
    } catch (err) {
      return errorResult(err.message);
    }
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return send({ id: null, error: { code: -32600, message: "Invalid Request" } });
  }
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== "string") {
    if (isRequest && !("result" in message) && !("error" in message)) {
      send({ id, error: { code: -32600, message: "Invalid Request" } });
    }
    return;
  }
  if (!isRequest) return;
  const handler = Object.hasOwn(methods, method) ? methods[method] : null;
  if (!handler) return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  try {
    send({ id, result: await handler(params) });
  } catch (err) {
    send({ id, error: { code: err instanceof RpcError ? err.code : -32603, message: err.message } });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  handle(message);
});

console.error("[understand-anything-mcp] server ready on stdio");
