---
name: understand-domain
description: Extract business domain knowledge (business domains, flows and process steps) from a codebase into a domain graph for the Domain view of the claude-dashboard Understand page. Works standalone (lightweight scan) or derives from an existing /understand map. Use when the user types /understand-domain, or asks to extract or map the business domains or flows of a codebase.
argument-hint: "[--full]"
---

# /understand-domain

Extracts business domain knowledge — domains, business flows, and process steps — from a codebase and saves a domain flow graph, `$DATA/domain-graph.json`, in the project's data folder (`~/.claude/understand/<key>/`, resolved in Phase 0). The Understand page of claude-dashboard (`http://127.0.0.1:3737/understand`) shows it as its Domain view.

Nothing is ever written inside the project. The deterministic scripts live in `{{CLAUDE_DASHBOARD}}/src/understand/scripts/`; the agent prompt is `~/.claude/skills/understand/agents/domain-analyzer.md`. Adapted from Understand Anything's `/understand-domain` skill (MIT, see `{{CLAUDE_DASHBOARD}}/src/understand/LICENSE-understand-anything`).

## How It Works

- If a knowledge graph already exists (`$DATA/knowledge-graph.json`, made by `/understand`), derives domain knowledge from it (cheap, no file scanning)
- If no knowledge graph exists, performs a lightweight scan: file tree + entry point detection + sampled files
- Use `--full` flag to force a fresh scan even if a knowledge graph exists

## Instructions

### Phase 0: Resolve `PROJECT_ROOT` and `$DATA`

1. Set `PROJECT_ROOT` to the current working directory. **Worktree redirect:** if `PROJECT_ROOT` is inside a git worktree (not the main checkout), redirect to the main repository root. Worktrees managed by Claude Code are ephemeral, and the data folder is keyed by `PROJECT_ROOT`, so without the redirect every short-lived worktree would get its own orphan graph instead of sharing the main checkout's (upstream issue #133). Detect a worktree by comparing `git rev-parse --git-dir` against `git rev-parse --git-common-dir`; in a normal checkout or submodule they resolve to the same path, in a worktree they differ and the parent of `--git-common-dir` is the main repo root. The same command then resolves the data folder:

   ```bash
   PROJECT_ROOT=$(pwd -P)
   COMMON_DIR=$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir 2>/dev/null)
   OWN_GIT_DIR=$(git -C "$PROJECT_ROOT" rev-parse --git-dir 2>/dev/null)
   if [ -n "$COMMON_DIR" ] && [ -n "$OWN_GIT_DIR" ]; then
     COMMON_ABS=$(cd "$PROJECT_ROOT" && cd "$COMMON_DIR" 2>/dev/null && pwd -P)
     OWN_ABS=$(cd "$PROJECT_ROOT" && cd "$OWN_GIT_DIR" 2>/dev/null && pwd -P)
     if [ -n "$COMMON_ABS" ] && [ "$COMMON_ABS" != "$OWN_ABS" ]; then
       MAIN_ROOT=$(dirname "$COMMON_ABS")
       if [ -d "$MAIN_ROOT" ] && [ "${UNDERSTAND_NO_WORKTREE_REDIRECT:-0}" != "1" ]; then
         echo "[understand-domain] Detected git worktree at $PROJECT_ROOT"
         echo "[understand-domain] Redirecting output to main repo root: $MAIN_ROOT"
         echo "[understand-domain] (Set UNDERSTAND_NO_WORKTREE_REDIRECT=1 to keep PROJECT_ROOT as the worktree.)"
         PROJECT_ROOT="$MAIN_ROOT"
       fi
     fi
   fi
   test -f {{CLAUDE_DASHBOARD}}/src/understand/scripts/extract-domain-context.mjs \
     && test -d {{CLAUDE_DASHBOARD}}/node_modules/zod && echo "pipeline ok"
   echo "HEAD_COMMIT=$(git -C "$PROJECT_ROOT" rev-parse --verify -q HEAD 2>/dev/null)"
   node {{CLAUDE_DASHBOARD}}/src/understand/scripts/data-dir.mjs "$PROJECT_ROOT" \
     | node -e 'const fs=require("fs"),j=JSON.parse(fs.readFileSync(0,"utf8")),f=j.dataDir+"/knowledge-graph.json";let g=null;try{g=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}console.log("DATA="+j.dataDir);console.log("KEY="+j.key);console.log("PROJECT_ROOT="+j.projectRoot);console.log("GRAPH="+(g?"present":fs.existsSync(f)?"unreadable":"missing"));if(g){console.log("KIND="+(g.kind||"code"));console.log("GRAPH_COMMIT_RAW="+((g.project||{}).gitCommitHash||""))}'
   ```

2. If it does not print `pipeline ok`, tell the user: "The Understand pipeline is missing from claude-dashboard (`{{CLAUDE_DASHBOARD}}/src/understand/`), or its packages are not installed (run `npm install` in `{{CLAUDE_DASHBOARD}}`)." and **STOP**. If `data-dir.mjs` fails, report its stderr and **STOP**.
3. Carry the printed values forward and substitute them in later commands, which may run in a fresh shell: `$DATA` (the data folder), `$KEY` (for the page link), `PROJECT_ROOT` (the real path the folder is keyed by), `HEAD_COMMIT` (empty when the project has no commit), `GRAPH`, `KIND` and `GRAPH_COMMIT_RAW`.
4. If `KIND` is `knowledge` or `design`, this folder holds a wiki or Figma map, not a code map: tell the user that `/understand-domain` works on code projects and **STOP**.

### Phase 1: Detect Existing Graph

1. Check `GRAPH` from Phase 0 (whether `$DATA/knowledge-graph.json` exists and parses).
2. If it is `present` AND `--full` was NOT passed, check freshness before deriving from it:
   - `GRAPH_COMMIT_RAW` is `project.gitCommitHash` from the graph metadata. Resolve it as a commit before using it in any Git diff, compare the resolved commit with `git rev-parse HEAD`, and inspect project-scoped committed and working-tree changes:
     ```bash
     PROJECT_ROOT="<PROJECT_ROOT>"; GRAPH_COMMIT_RAW="<GRAPH_COMMIT_RAW>"
     GRAPH_COMMIT=$(git -C "$PROJECT_ROOT" rev-parse --verify --end-of-options "${GRAPH_COMMIT_RAW}^{commit}" 2>/dev/null)
     echo "GRAPH_COMMIT=$GRAPH_COMMIT"
     git -C "$PROJECT_ROOT" rev-parse HEAD
     [ -n "$GRAPH_COMMIT" ] && git -C "$PROJECT_ROOT" diff --name-only "$GRAPH_COMMIT" HEAD -- .
     git -C "$PROJECT_ROOT" diff --cached --name-only -- .
     git -C "$PROJECT_ROOT" diff --name-only -- .
     git -C "$PROJECT_ROOT" ls-files --others --exclude-standard -- .
     ```
   - The `-- .` pathspec is required: commits that only touch a sibling monorepo project must not make this graph stale. A hash mismatch alone is not stale when the project diff is empty.
   - The data folder lives outside the project, so no output line is a generated graph artifact: every listed path is project source drift.
   - If the committed diff or any working-tree command reports project files, warn that domain extraction may omit those changes. Suggest: Run `/understand` to refresh the knowledge graph.
   - Run the commit diff only when `GRAPH_COMMIT_RAW` resolves successfully. If the graph commit or Git metadata is missing, invalid, or unavailable, give a brief best-effort warning and continue instead of blocking.
3. After that preflight, proceed to Phase 3 (derive from graph).
4. Otherwise (`GRAPH` is `missing` or `unreadable`, or `--full` was passed), proceed to Phase 2 (lightweight scan). When `--full` is used, skip this preflight because the command performs a fresh scan instead of consuming the existing graph.

### Phase 2: Lightweight Scan (Path 1)

The preprocessing script does NOT produce a domain graph — it produces **raw material** (file tree, entry points, exports/imports) so the domain-analyzer agent can focus on the actual domain analysis instead of spending dozens of tool calls exploring the codebase. Think of it as a cheat sheet: cheap Node preprocessing → expensive LLM gets a clean, small input → better results for less cost.

1. Run the preprocessing script, passing `$PROJECT_ROOT` from Phase 0:
   ```bash
   node {{CLAUDE_DASHBOARD}}/src/understand/scripts/extract-domain-context.mjs "<PROJECT_ROOT>"
   ```
   This outputs `$DATA/intermediate/domain-context.json` containing:
   - File tree (respecting `.gitignore`)
   - Detected entry points (HTTP routes, CLI commands, event handlers, cron jobs, exported handlers)
   - File signatures (exports, imports per file)
   - Code snippets for each entry point (signature + first few lines)
   - Project metadata (package.json, README, etc.)

   If it exits non-zero, report its stderr and **STOP**.
2. `$DATA/intermediate/domain-context.json` is the context for Phase 4 (Option A). Do not read it yourself: the agent reads it.
3. Proceed to Phase 4

### Phase 3: Derive from Existing Graph (Path 2)

1. Format the graph data as structured context, one record per line: all nodes with their types, names, summaries, and tags; all edges with their types (especially `calls`, `imports`, `contains`); all layers with their descriptions; tour steps if available:
   ```bash
   DATA="<DATA>"; mkdir -p "$DATA/intermediate"
   node - "$DATA" <<'NODE'
   const fs = require('fs');
   const data = process.argv[2];
   const g = JSON.parse(fs.readFileSync(`${data}/knowledge-graph.json`, 'utf8'));
   const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
   const block = (name, items) => `"${name}": [\n${items.map((x) => JSON.stringify(x)).join(',\n')}\n]`;
   const parts = [
     block('layers', (g.layers || []).map((l) => pick(l, ['id', 'name', 'description', 'nodeIds']))),
     block('tour', (g.tour || []).map((t) => pick(t, ['order', 'title', 'description', 'nodeIds']))),
     block('nodes', (g.nodes || []).map((n) => pick(n, ['id', 'type', 'name', 'filePath', 'summary', 'tags']))),
     block('edges', (g.edges || []).map((e) => pick(e, ['source', 'target', 'type']))),
   ];
   fs.writeFileSync(`${data}/intermediate/domain-graph-context.json`, `{"project": ${JSON.stringify(g.project || {})},\n${parts.join(',\n')}\n}\n`);
   console.log(`Graph digest: ${(g.nodes || []).length} nodes, ${(g.edges || []).length} edges, ${(g.layers || []).length} layers, ${(g.tour || []).length} tour steps`);
   NODE
   ```
2. `$DATA/intermediate/domain-graph-context.json` is the context for the domain analyzer (Option B) — no file reading needed. Do not read it yourself: the agent reads it.
3. Proceed to Phase 4

### Phase 4: Domain Analysis

1. Dispatch a subagent with the Agent tool: `subagent_type: "general-purpose"`, `description: "understand-domain: domain-analyzer"`, no `model`, and this `prompt` (substitute every `<placeholder>`; never read the agent file yourself or paste its text):
   ```
   Read ~/.claude/skills/understand/agents/domain-analyzer.md completely and follow it as your instructions.

   Context: <"Option A — Preprocessed domain context" after Phase 2, or "Option B — Existing knowledge graph" after Phase 3>
   Context file: <$DATA/intermediate/domain-context.json after Phase 2, or $DATA/intermediate/domain-graph-context.json after Phase 3>
   Project root: <PROJECT_ROOT>
   Git commit: <SOURCE_COMMIT, or "none" when empty>
   Output path: <DATA>/intermediate/domain-analysis.json
   ```
   `SOURCE_COMMIT` is the commit the context reflects: `HEAD_COMMIT` after Phase 2, `GRAPH_COMMIT_RAW` after Phase 3 (a domain graph derived from the map is only as fresh as the map, so the page's freshness banner stays truthful).
2. The agent writes its output to `$DATA/intermediate/domain-analysis.json` and replies with a short summary.

### Phase 5: Validate and Save

1. Read the domain analysis output, validate it with the standard graph validation pipeline (core `validateGraph`; the schema supports domain/flow/step types), and save it to `$DATA/domain-graph.json`. If validation finds problems, log warnings but save what's valid (error tolerance). The save also sets `project.gitCommitHash` to `SOURCE_COMMIT` and `project.analyzedAt` to now, makes absolute step `filePath`s relative to the project root, and gives every `flow_step` edge an integer `order` (1, 2, 3, ... per flow: the agent's `order` first, then UA's weight, then file order), because the validator keeps neither `order` nor anything outside its schema:
   ```bash
   node --input-type=module - "<DATA>" "<PROJECT_ROOT>" "<SOURCE_COMMIT>" <<'NODE'
   import { readFileSync, renameSync, writeFileSync } from 'node:fs';
   import { basename, isAbsolute, join, relative } from 'node:path';
   import { pathToFileURL } from 'node:url';
   const [data, root, commit] = process.argv.slice(2);
   const { validateGraph } = await import(pathToFileURL('{{CLAUDE_DASHBOARD}}/src/understand/core/schema.js').href);
   const raw = JSON.parse(readFileSync(join(data, 'intermediate/domain-analysis.json'), 'utf8'));
   if (raw && raw.project && typeof raw.project === 'object') raw.project = { ...raw.project, gitCommitHash: commit || '', analyzedAt: new Date().toISOString() };
   const result = validateGraph(raw);
   for (const issue of result.issues || []) console.log(`warning [${issue.level}] ${issue.message}`);
   if (!result.success) {
     console.error(`Domain graph not saved: ${result.fatal}`);
     process.exit(1);
   }
   const graph = result.data;
   for (const n of graph.nodes) if (typeof n.filePath === 'string' && isAbsolute(n.filePath)) n.filePath = n.filePath.startsWith(`${root}/`) ? relative(root, n.filePath) : basename(n.filePath);
   const asked = new Map();
   for (const e of Array.isArray(raw.edges) ? raw.edges : []) if (e && Number.isInteger(e.order) && e.order > 0) asked.set(`${e.source}\n${e.target}`, e.order);
   const flows = new Map();
   graph.edges.forEach((e, i) => {
     if (e.type !== 'flow_step') return;
     if (!flows.has(e.source)) flows.set(e.source, []);
     flows.get(e.source).push([asked.get(`${e.source}\n${e.target}`) ?? Infinity, e.weight, i, e]);
   });
   for (const steps of flows.values()) steps.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).forEach((s, k) => { s[3].order = k + 1; });
   const out = join(data, 'domain-graph.json');
   writeFileSync(`${out}.tmp`, `${JSON.stringify(graph, null, 2)}\n`);
   renameSync(`${out}.tmp`, out);
   const count = (t) => graph.nodes.filter((n) => n.type === t).length;
   console.log(`Saved ${out}: ${count('domain')} domains, ${count('flow')} flows, ${count('step')} steps, ${graph.edges.length} edges`);
   NODE
   ```
   If it exits non-zero (`Domain graph not saved: <reason>`, or a read or JSON error when the agent wrote no valid file), report the reason and the warnings, keep `$DATA/intermediate/domain-analysis.json` for inspection, and **STOP**.
2. Clean up the intermediate files:
   ```bash
   rm -f "<DATA>/intermediate/domain-analysis.json" "<DATA>/intermediate/domain-context.json" "<DATA>/intermediate/domain-graph-context.json"
   ```

### Phase 6: Open the Dashboard

1. Make sure claude-dashboard runs (this replaces Understand Anything's own dashboard launch):
   ```bash
   node {{CLAUDE_DASHBOARD}}/bin/claude-dashboard.js status
   ```
   If it says the dashboard is not running, start it in the background without opening a browser. Run this with the Bash tool's `run_in_background: true`: the command waits for the dashboard's transcript scan before it exits, while the server itself runs detached:
   ```bash
   node {{CLAUDE_DASHBOARD}}/bin/claude-dashboard.js start --no-open
   ```
   Then run `status` again until it reports `Running at ...`. If `status` reports another port (3737 was taken), use that port in the link. If the dashboard does not come up, say so, give the log path `status` or `start` printed, and still print the link.
2. Report the domain, flow and step counts with the key domain names, then print the link `http://127.0.0.1:3737/understand?project=<KEY>` and tell the user to switch the page to its Domain view.
