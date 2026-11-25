---
name: understand-explain
description: Deep-dive explanation of one file, function or module from a codebase's Understand map (the knowledge graph /understand saved in ~/.claude/understand) plus its source. Use when the user types /understand-explain, or asks for an in-depth explanation of a specific file or function using the knowledge graph.
argument-hint: "[file-path]"
---

# /understand-explain

Provide a thorough, in-depth explanation of a specific code component, using the knowledge graph in the project's data folder `$DATA` (`~/.claude/understand/<key>/knowledge-graph.json`, made by `/understand` and resolved in step 1) and the component's source file.

Nothing is written inside the project. Adapted from Understand Anything's `/understand-explain` skill (MIT, see `{{CLAUDE_DASHBOARD}}/src/understand/LICENSE-understand-anything`).

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

1. **Resolve the data folder `$DATA`.** The map is not inside the project: `/understand` saves it in `~/.claude/understand/<key>/`, keyed by the project's real path. Run this from the project root (the current working directory). Like `/understand`, it redirects a git worktree to its main checkout, whose map the worktree shares (set `UNDERSTAND_NO_WORKTREE_REDIRECT=1` to keep the worktree itself):
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
         echo "[understand] Detected git worktree at $PROJECT_ROOT"
         echo "[understand] Using the main repo's map: $MAIN_ROOT"
         PROJECT_ROOT="$MAIN_ROOT"
       fi
     fi
   fi
   node {{CLAUDE_DASHBOARD}}/src/understand/scripts/data-dir.mjs "$PROJECT_ROOT" \
     | node -e 'const fs=require("fs"),j=JSON.parse(fs.readFileSync(0,"utf8")),f=j.dataDir+"/knowledge-graph.json";let g=null;try{g=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}console.log("DATA="+j.dataDir);console.log("KEY="+j.key);console.log("PROJECT_ROOT="+j.projectRoot);console.log("GRAPH="+(g?f:fs.existsSync(f)?"unreadable":"missing"));if(g){const p=g.project||{};console.log("KIND="+(g.kind||"code"));console.log("GRAPH_COMMIT_RAW="+(p.gitCommitHash||""));console.log("PROJECT="+JSON.stringify({name:p.name,description:p.description,languages:p.languages,frameworks:p.frameworks,analyzedAt:p.analyzedAt,nodes:(g.nodes||[]).length,edges:(g.edges||[]).length,layers:(g.layers||[]).length,tour:(g.tour||[]).length}))}'
   ```
   `data-dir.mjs` prints one JSON line `{"key","dataDir","projectRoot"}` (it creates the empty folder when the project has none yet); the `node -e` part parses it and peeks at the map. If the command fails, report its stderr and **STOP**. Carry the printed values forward and substitute them in later commands, which may run in a fresh shell: `$DATA`, `$KEY` (for the page link), `PROJECT_ROOT` (the real path the map is keyed by), `GRAPH_COMMIT_RAW` and `PROJECT`. If `GRAPH` is `missing` or `unreadable`, tell the user to run `/understand` first and **STOP**.

2. **Check graph freshness before using graph-derived context**:
   - `GRAPH_COMMIT_RAW` (from step 1) is `project.gitCommitHash` from the graph metadata. Resolve it as a commit before using it in any Git diff, then compare it with `HEAD` and inspect project-scoped committed and working-tree changes of the project root:
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
   - If the committed diff or any working-tree command reports project files, warn before explaining that graph-derived context may omit those changes. Suggest: Run `/understand` to refresh the graph.
   - The commit diff runs only when `GRAPH_COMMIT_RAW` resolves successfully. If the graph commit or Git metadata is missing, invalid, or unavailable, give a brief best-effort warning and continue instead of blocking.

3. **Find the target node**: use Grep to search `$DATA/knowledge-graph.json` for the component: "$ARGUMENTS"
   - Node `filePath`s are relative to the project root: if the argument is an absolute path inside `$PROJECT_ROOT` or starts with `./`, make it relative first
   - For file paths (e.g., `src/auth/login.ts`): search for `"filePath"` matches
   - For function notation (e.g., `src/auth/login.ts:verifyToken`): search for the function name in `"name"` fields filtered by the file path
   - Note the exact node `id`, `type`, `summary`, `tags`, and `complexity`
   - If no node matches, say the path was not found in the knowledge graph for the project (from `PROJECT`), with the possible reasons: the file hasn't been analyzed yet (try running `/understand` first), the path may be different in the graph (check the exact file path), or the file may have been deleted or renamed since the last analysis. Then **STOP**.

4. **Find all connected edges**: Grep for the target node's ID in the edges section:
   - `"source"` matches → things this node calls/imports/depends on (outgoing)
   - `"target"` matches → things that call/import/depend on this node (incoming)
   - Note the connected node IDs and edge types

5. **Read connected nodes**: for each connected node ID from step 4, Grep for those IDs in the nodes section to get their `name`, `summary`, and `type`. This builds the component's neighborhood.

6. **Identify the layer**: Grep for the target node's ID in the `"layers"` section to find which architectural layer it belongs to and that layer's description.

7. **Read the actual source file**: Read the source file at `$PROJECT_ROOT/<filePath>` (the node's `filePath`) for the deep-dive analysis.

8. **Explain the component in context**:
   - Its role in the architecture (which layer, why it exists)
   - Internal structure (functions, classes it contains, from `contains` edges)
   - External connections (what it imports, what calls it, what it depends on, from edges)
   - Data flow (inputs → processing → outputs, from source code)
   - Explain clearly, assuming the reader may not know the programming language
   - Highlight any patterns, idioms, or complexity worth understanding

9. **Link the map.** End with one line linking the component on the Understand page: `http://127.0.0.1:3737/understand?project=$KEY&node=<target node id, URL-encoded with encodeURIComponent>`.
