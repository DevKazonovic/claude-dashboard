---
name: understand-onboard
description: Generate an onboarding guide for new team members from a codebase's Understand map (the knowledge graph /understand saved in ~/.claude/understand), saved next to the map. Use when the user types /understand-onboard, or asks for an onboarding guide built from the knowledge graph.
---

# /understand-onboard

Generate a comprehensive onboarding guide from the knowledge graph in the project's data folder `$DATA` (`~/.claude/understand/<key>/knowledge-graph.json`, made by `/understand` and resolved in step 1). The guide is saved to `$DATA/onboarding.md`.

Nothing is written inside the project, except the copy in `docs/UA_ONBOARDING.md` that step 11 offers and makes only on the user's yes. Adapted from Understand Anything's `/understand-onboard` skill (MIT, see `{{CLAUDE_DASHBOARD}}/src/understand/LICENSE-understand-anything`).

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
   - If the committed diff or any working-tree command reports project files, warn before generating the guide that onboarding content may omit those changes. Suggest: Run `/understand` to refresh the graph.
   - The commit diff runs only when `GRAPH_COMMIT_RAW` resolves successfully. If the graph commit or Git metadata is missing, invalid, or unavailable, give a brief best-effort warning and continue instead of blocking.

3. **Read project metadata**: the `PROJECT` line from step 1 already holds the `"project"` section (name, description, languages, frameworks).

4. **Read layers**: Grep `$DATA/knowledge-graph.json` for `"layers"` to get the full layers array. These define the architecture and will structure the guide.

5. **Read the tour**: Grep for `"tour"` to get the guided walkthrough steps. These provide the recommended learning path.

6. **Read file-level structural nodes only**: use Grep to find nodes with file-level types (`file`, `config`, `document`, `service`, `pipeline`, `table`, `schema`, `resource`, `endpoint`) in the knowledge graph. Skip function-level and class-level nodes to keep the guide high-level. Extract each node's `name`, `filePath`, `summary`, and `complexity`.

7. **Identify complexity hotspots**: from the file-level nodes, find those with the highest `complexity` values. These are areas new developers should approach carefully.

8. **Generate the onboarding guide** with these sections:
   - **Project Overview**: name, languages, frameworks, description (from project metadata)
   - **Architecture Layers**: each layer's name, description, and key files (from layers + file nodes)
   - **Key Concepts**: important patterns and design decisions (from node summaries and tags)
   - **Guided Tour**: step-by-step walkthrough (from the tour section)
   - **File Map**: what each key file does (from file-level nodes, organized by layer)
   - **Complexity Hotspots**: areas to approach carefully (from complexity values)

9. Format as clean markdown

10. **Save the guide** to `$DATA/onboarding.md`, replacing any older guide (with the Write tool: if the file already exists, Read it first with `limit: 1`, because Write refuses to overwrite a file it has not read). Then show the guide to the user, followed by its path and the Understand page link `http://127.0.0.1:3737/understand?project=$KEY`.

11. Offer to save a copy to `docs/UA_ONBOARDING.md` in the project (say it replaces the existing file when `$PROJECT_ROOT/docs/UA_ONBOARDING.md` already exists). Only if the user says yes:
    ```bash
    mkdir -p "<PROJECT_ROOT>/docs" && cp -f "<DATA>/onboarding.md" "<PROJECT_ROOT>/docs/UA_ONBOARDING.md"
    ```
    Without a yes, write nothing in the project.

12. After a saved copy, suggest the user commit it to the repo for the team (never commit it yourself).
