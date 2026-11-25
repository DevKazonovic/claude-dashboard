---
name: understand-diff
description: Analyze git changes or a pull request against a codebase's Understand map (the knowledge graph /understand saved in ~/.claude/understand) to show what changed, what is affected and the risks, and mark the changed and affected boxes on the Understand page. Use when the user types /understand-diff, or asks to analyze a diff or PR using the knowledge graph.
---

# /understand-diff

Analyze the current code changes against the knowledge graph in the project's data folder `$DATA` (`~/.claude/understand/<key>/knowledge-graph.json`, made by `/understand` and resolved in step 1), then write `$DATA/diff-overlay.json` so the Understand page of claude-dashboard (`http://127.0.0.1:3737/understand`) marks the changed and affected components.

Nothing is written inside the project. Adapted from Understand Anything's `/understand-diff` skill (MIT, see `{{CLAUDE_DASHBOARD}}/src/understand/LICENSE-understand-anything`).

## Graph Structure Reference

The knowledge graph JSON has this structure:
- `kind` (optional, top level): `"knowledge"` for a wiki map (`/understand-knowledge`), `"design"` for a Figma map; absent or anything else is a code map
- `project`: {name, description, languages, frameworks, analyzedAt, gitCommitHash}
- `nodes[]`: each has {id, type, name, filePath?, summary, tags[], complexity, languageNotes?}
  - Code node types: file, function, class, module, concept
  - Non-code node types: config, document, service, table, endpoint, pipeline, schema, resource
  - Domain/knowledge node types: domain, flow, step, article, entity, topic, claim, source
  - IDs use the node type as prefix, e.g. `file:path`, `function:path:name`, `config:path`, `article:path`
- `edges[]`: each has {source, target, type, direction, weight}
  - Key types: imports, contains, calls, depends_on, configures, documents, deploys, triggers, contains_flow, flow_step, related, cites
- `layers[]`: each has {id, name, description, nodeIds[]}
- `tour[]`: each has {order, title, description, nodeIds[]}

## How to Read Efficiently

1. Use Grep to search within the JSON for relevant entries BEFORE reading the full file
2. Only read sections you need; don't dump the entire graph into context
3. Node names and summaries are the most useful fields for understanding
4. Edges tell you how components connect; follow imports and calls for dependency chains

## Instructions

1. **Resolve the data folder `$DATA`.** The map is not inside the project: `/understand` saves it in `~/.claude/understand/<key>/`, keyed by the project's real path. Run this from the project root (the current working directory). Like `/understand`, it redirects a git worktree to its main checkout, whose map the worktree shares (set `UNDERSTAND_NO_WORKTREE_REDIRECT=1` to keep the worktree itself). `START_DIR` keeps the directory the command started in: the changes are read there, so a worktree's own changes are mapped onto the main checkout's map.
   ```bash
   START_DIR=$(pwd -P)
   PROJECT_ROOT="$START_DIR"
   COMMON_DIR=$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir 2>/dev/null)
   OWN_GIT_DIR=$(git -C "$PROJECT_ROOT" rev-parse --git-dir 2>/dev/null)
   if [ -n "$COMMON_DIR" ] && [ -n "$OWN_GIT_DIR" ]; then
     COMMON_ABS=$(cd "$PROJECT_ROOT" && cd "$COMMON_DIR" 2>/dev/null && pwd -P)
     OWN_ABS=$(cd "$PROJECT_ROOT" && cd "$OWN_GIT_DIR" 2>/dev/null && pwd -P)
     if [ -n "$COMMON_ABS" ] && [ "$COMMON_ABS" != "$OWN_ABS" ]; then
       MAIN_ROOT=$(dirname "$COMMON_ABS")
       if [ -d "$MAIN_ROOT" ] && [ "${UNDERSTAND_NO_WORKTREE_REDIRECT:-0}" != "1" ]; then
         echo "[understand] Detected git worktree at $PROJECT_ROOT"
         echo "[understand] Using the main repo's map: $MAIN_ROOT"
         PROJECT_ROOT="$MAIN_ROOT"
       fi
     fi
   fi
   echo "START_DIR=$START_DIR"
   node {{CLAUDE_DASHBOARD}}/src/understand/scripts/data-dir.mjs "$PROJECT_ROOT" \
     | node -e 'const fs=require("fs"),j=JSON.parse(fs.readFileSync(0,"utf8")),f=j.dataDir+"/knowledge-graph.json";let g=null;try{g=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}console.log("DATA="+j.dataDir);console.log("KEY="+j.key);console.log("PROJECT_ROOT="+j.projectRoot);console.log("GRAPH="+(g?f:fs.existsSync(f)?"unreadable":"missing"));if(g){const p=g.project||{};console.log("KIND="+(g.kind||"code"));console.log("GRAPH_COMMIT_RAW="+(p.gitCommitHash||""));console.log("PROJECT="+JSON.stringify({name:p.name,description:p.description,languages:p.languages,frameworks:p.frameworks,analyzedAt:p.analyzedAt,nodes:(g.nodes||[]).length,edges:(g.edges||[]).length,layers:(g.layers||[]).length,tour:(g.tour||[]).length}))}'
   ```
   `data-dir.mjs` prints one JSON line `{"key","dataDir","projectRoot"}` (it creates the empty folder when the project has none yet); the `node -e` part parses it and peeks at the map. If the command fails, report its stderr and **STOP**. Carry the printed values forward and substitute them in later commands, which may run in a fresh shell: `START_DIR`, `$DATA`, `$KEY` (for the page link), `PROJECT_ROOT` (the real path the map is keyed by), `GRAPH_COMMIT_RAW` and `PROJECT`. If `GRAPH` is `missing` or `unreadable`, tell the user to run `/understand` first and **STOP**.

2. **Get the changed files list** (do NOT read the graph yet). Paths must be relative to the project root, like node `filePath`s, so every git command below uses `--relative`. Each command prints the list and saves it, one path per line, to `$DATA/tmp/diff-changed-files.txt` for step 4. Note the base you used as `BASE_REF`:
   - If on a branch with uncommitted changes (staged, unstaged and new files), `BASE_REF` = `HEAD`:
     ```bash
     START_DIR="<START_DIR>"; DATA="<DATA>"; mkdir -p "$DATA/tmp"
     { git -C "$START_DIR" diff --name-only --relative; git -C "$START_DIR" diff --cached --name-only --relative; git -C "$START_DIR" ls-files --others --exclude-standard; } | sort -u | tee "$DATA/tmp/diff-changed-files.txt"
     ```
   - If on a feature branch: the branch against its base, `main` (or the base branch), `BASE_REF` = that branch name:
     ```bash
     START_DIR="<START_DIR>"; DATA="<DATA>"; mkdir -p "$DATA/tmp"
     git -C "$START_DIR" diff --name-only --relative "main...HEAD" | tee "$DATA/tmp/diff-changed-files.txt"
     ```
   - If the user specifies a PR number: get the diff from that PR, `BASE_REF` = `PR #<number>`. `gh` prints paths from the repo top, so keep only the project's files, made relative:
     ```bash
     START_DIR="<START_DIR>"; DATA="<DATA>"; mkdir -p "$DATA/tmp"
     PREFIX=$(git -C "$START_DIR" rev-parse --show-prefix)
     (cd "$START_DIR" && gh pr diff <number> --name-only) | awk -v p="$PREFIX" 'index($0, p) == 1 { print substr($0, length(p) + 1) }' | tee "$DATA/tmp/diff-changed-files.txt"
     ```
   - If the list is empty, tell the user there are no changes to analyze, still run step 4 (it records the empty diff, so the page stops marking an older one), then **STOP**.

3. **Read project metadata and check graph freshness**: the `PROJECT` line from step 1 already holds the `"project"` section, and `GRAPH_COMMIT_RAW` is its `gitCommitHash`. Then:
   - Resolve it as a commit before using it in any Git diff. Compare the resolved commit with `HEAD` and inspect project-scoped committed and working-tree changes of the project root:
     ```bash
     PROJECT_ROOT="<PROJECT_ROOT>"; GRAPH_COMMIT_RAW="<GRAPH_COMMIT_RAW>"
     GRAPH_COMMIT=$(git -C "$PROJECT_ROOT" rev-parse --verify --end-of-options "${GRAPH_COMMIT_RAW}^{commit}" 2>/dev/null)
     echo "graph commit: ${GRAPH_COMMIT:-unresolved}"
     echo "HEAD: $(git -C "$PROJECT_ROOT" rev-parse --verify -q HEAD || echo unavailable)"
     if [ -n "$GRAPH_COMMIT" ]; then echo "--- committed since the graph:"; git -C "$PROJECT_ROOT" diff --name-only "$GRAPH_COMMIT" HEAD -- .; fi
     echo "--- staged:"; git -C "$PROJECT_ROOT" diff --cached --name-only -- .
     echo "--- unstaged:"; git -C "$PROJECT_ROOT" diff --name-only -- .
     echo "--- untracked:"; git -C "$PROJECT_ROOT" ls-files --others --exclude-standard -- .
     ```
   - The `-- .` pathspec is required: commits that only touch a sibling monorepo project must not make this graph stale. A hash mismatch alone is not stale when the project diff is empty.
   - The map lives outside the project, so every file these commands list is project source drift; there is no generated data folder to ignore.
   - If the committed diff or any working-tree command reports project files, warn before impact analysis that the graph may omit those changes. Suggest: Run `/understand` to refresh the graph.
   - The commit diff runs only when `GRAPH_COMMIT_RAW` resolves successfully. If the graph commit or Git metadata is missing, invalid, or unavailable, give a brief best-effort warning and continue instead of blocking.

4. **Find changed nodes, affected nodes and layers, and write the diff overlay.** This command does the graph lookups in one pass, with the same rules as grepping by hand:
   - Changed nodes: every node whose `filePath` is a changed file (file-level nodes, including non-code types, AND function/class nodes defined in those files), plus the targets of their `contains` edges. Changed files with no node are unmapped.
   - Affected nodes: the other end of every edge that touches a changed node (upstream callers and importers, downstream dependencies), excluding changed nodes. These are the components that might break or need updating.
   - Layers: the layers holding changed or affected nodes. A node outside every layer counts in the layer of its file.
   - Risk: `High complexity` (any changed node is `complex`), `Cross-layer impact` (more than one layer), `Wide blast radius` (more than 5 affected nodes), `New/unmapped files` (any unmapped file); none of them means `Low risk`. Level `low` with none, `medium` with one, `high` with two or more.

   It then writes `$DATA/diff-overlay.json` = `{ version: 1, changedNodeIds, affectedNodeIds, changedFiles, headCommit, baseRef, generatedAt, risk: { level, factors } }` (`headCommit` = `git -C "$PROJECT_ROOT" rev-parse HEAD`, or `null` when the repo has no commit yet; `generatedAt` = ISO timestamp), replacing any older overlay, and deletes the changed-files list.
   ```bash
   DATA="<DATA>"; PROJECT_ROOT="<PROJECT_ROOT>"; BASE_REF="<BASE_REF>"
   node - "$DATA" "$PROJECT_ROOT" "$BASE_REF" <<'NODE'
   const fs = require('fs');
   const { execFileSync } = require('child_process');
   const [data, root, baseRef] = process.argv.slice(2);
   const listFile = `${data}/tmp/diff-changed-files.txt`;
   const g = JSON.parse(fs.readFileSync(`${data}/knowledge-graph.json`, 'utf8'));
   const nodes = g.nodes || [], edges = g.edges || [], layers = g.layers || [];
   const changedFiles = [...new Set(fs.readFileSync(listFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean))];
   const fileSet = new Set(changedFiles);
   const byId = new Map(nodes.map((n) => [n.id, n]));
   const changed = new Set(nodes.filter((n) => fileSet.has(n.filePath)).map((n) => n.id));
   const mapped = new Set(nodes.filter((n) => fileSet.has(n.filePath)).map((n) => n.filePath));
   const unmapped = changedFiles.filter((f) => !mapped.has(f));
   for (const e of edges) if (e.type === 'contains' && changed.has(e.source)) changed.add(e.target);
   const affected = new Set(), impacted = [];
   for (const e of edges) {
     const s = changed.has(e.source), t = changed.has(e.target);
     if (!s && !t) continue;
     impacted.push(e);
     if (s && !t) affected.add(e.target);
     if (t && !s) affected.add(e.source);
   }
   const layerOf = new Map(), fileLayer = new Map();
   for (const l of layers) for (const id of l.nodeIds || []) {
     if (!layerOf.has(id)) layerOf.set(id, l);
     const fp = byId.get(id)?.filePath;
     if (fp && !fileLayer.has(fp)) fileLayer.set(fp, l);
   }
   const lay = (id) => layerOf.get(id) || fileLayer.get(byId.get(id)?.filePath);
   const hit = new Set([...changed, ...affected].map(lay).filter(Boolean));
   const touched = layers.filter((l) => hit.has(l));
   const cross = impacted.filter((e) => lay(e.source) && lay(e.target) && lay(e.source) !== lay(e.target)).length;
   const changedNodes = nodes.filter((n) => changed.has(n.id)), affectedNodes = nodes.filter((n) => affected.has(n.id));
   const complex = changedNodes.filter((n) => n.complexity === 'complex');
   const factors = [];
   if (complex.length) factors.push(`High complexity: ${complex.length} complex component(s) changed: ${complex.map((n) => n.name).join(', ')}`);
   if (touched.length > 1) factors.push(`Cross-layer impact: Changes span ${touched.length} architectural layers`);
   if (affectedNodes.length > 5) factors.push(`Wide blast radius: ${affectedNodes.length} components affected downstream`);
   if (unmapped.length) factors.push(`New/unmapped files: ${unmapped.length} files not in the knowledge graph (may need re-analysis)`);
   const risk = factors.length ? { level: factors.length > 1 ? 'high' : 'medium', factors } : { level: 'low', factors: ['Low risk: Changes are localized with limited downstream impact.'] };
   let headCommit = null;
   try { headCommit = execFileSync('git', ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch {}
   const overlay = { version: 1, changedNodeIds: changedNodes.map((n) => n.id), affectedNodeIds: affectedNodes.map((n) => n.id), changedFiles, headCommit, baseRef, generatedAt: new Date().toISOString(), risk };
   const out = `${data}/diff-overlay.json`, tmp = `${out}.${process.pid}.tmp`;
   fs.writeFileSync(tmp, JSON.stringify(overlay, null, 2) + '\n');
   fs.renameSync(tmp, out);
   fs.rmSync(listFile, { force: true });
   // ponytail: prints 100 entries per list to spare context; the overlay keeps every id
   const show = (title, list, fmt) => { console.log(`\n${title} (${list.length}):`); for (const x of list.slice(0, 100)) console.log(fmt(x)); if (list.length > 100) console.log(`+${list.length - 100} more, every id is in diff-overlay.json`); };
   const line = (n) => `- ${n.id} (${n.type}, ${n.complexity}${lay(n.id) ? `, layer ${lay(n.id).name}` : ''}): ${n.summary}`;
   console.log(`Changed files: ${changedFiles.length} (${changedFiles.length - unmapped.length} mapped, ${unmapped.length} unmapped)`);
   show('Changed components', changedNodes, line);
   show('Affected components', affectedNodes, line);
   show('Impacted relationships', impacted, (e) => `- ${e.source} --[${e.type}]--> ${e.target}`);
   console.log(`Cross-layer relationships: ${cross}`);
   show('Affected layers', touched, (l) => `- ${l.name}: ${l.description}`);
   show('Unmapped files', unmapped, (f) => `- ${f}`);
   console.log(`\nRisk: ${risk.level}`);
   for (const f of risk.factors) console.log(`- ${f}`);
   console.log(`\nWrote ${out} (head ${headCommit || 'none'}, base ${baseRef})`);
   NODE
   ```
   If it fails, report the error and **STOP** (step 5's analysis must match the overlay).

5. **Provide structured analysis** from the step 4 report (Grep `$DATA/knowledge-graph.json` for a node, or read a changed source file under `$PROJECT_ROOT`, only when you need more detail):
   - **Changed Components**: What was directly modified (with summaries from matched nodes)
   - **Affected Components**: What might be impacted (from 1-hop edges)
   - **Affected Layers**: Which architectural layers are touched and cross-layer concerns
   - **Risk Assessment**: Based on node `complexity` values, number of cross-layer edges, and blast radius (number of affected components), starting from the step 4 `Risk` lines
   - Suggest what to review carefully and any potential issues

6. **Show it on the Understand page.** Make sure claude-dashboard runs:
   ```bash
   node {{CLAUDE_DASHBOARD}}/bin/claude-dashboard.js status
   ```
   If it says the dashboard is not running, start it in the background without opening a browser (Bash tool `run_in_background: true`; the server itself runs detached):
   ```bash
   node {{CLAUDE_DASHBOARD}}/bin/claude-dashboard.js start --no-open
   ```
   Then run `status` again until it reports `Running at ...`. Tell the user the Understand page now shows the changed and affected boxes, and give the link `http://127.0.0.1:3737/understand?project=$KEY` (use the port `status` reports if it is not 3737). If the dashboard does not come up, say so, give the log path `status` or `start` printed, and still give the link.
