---
name: understand-chat
description: Answer questions about a codebase from its Understand map (the knowledge graph /understand saved in ~/.claude/understand). Use when the user types /understand-chat, or asks to answer a question about a codebase using its knowledge graph.
argument-hint: "[query]"
---

# /understand-chat

Answer questions about this codebase using the knowledge graph in the project's data folder `$DATA` (`~/.claude/understand/<key>/knowledge-graph.json`, made by `/understand` and resolved in step 1). The map is shown on the Understand page of claude-dashboard (`http://127.0.0.1:3737/understand`).

Nothing is written inside the project. Adapted from Understand Anything's `/understand-chat` skill (MIT, see `{{CLAUDE_DASHBOARD}}/src/understand/LICENSE-understand-anything`).

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
   `data-dir.mjs` prints one JSON line `{"key","dataDir","projectRoot"}` (it creates the empty folder when the project has none yet); the `node -e` part parses it and peeks at the map. If the command fails, report its stderr and **STOP**. Carry the printed values forward and substitute them in later commands, which may run in a fresh shell: `$DATA`, `$KEY` (for the page link), `PROJECT_ROOT` (the real path the map is keyed by), `KIND`, `GRAPH_COMMIT_RAW` and `PROJECT`. If `GRAPH` is `missing` or `unreadable`, tell the user to run `/understand` first and **STOP**.

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
   - If the committed diff or any working-tree command reports project files, warn before answering that graph-derived context may omit those changes. Suggest: Run `/understand` to refresh the graph.
   - The commit diff runs only when `GRAPH_COMMIT_RAW` resolves successfully. If the graph commit or Git metadata is missing, invalid, or unavailable, give a brief best-effort warning and continue instead of blocking.

3. **Read project metadata only**: the `PROJECT` line from step 1 already holds the `"project"` section (name, description, languages, frameworks) plus the node, edge, layer and tour counts. Never read the whole file.

   **Wiki maps.** If `KIND` is `knowledge` (a wiki map made by `/understand-knowledge`, with articles, entities, topics, claims and sources instead of files and functions), the knowledge-graph guide answers instead of steps 4 to 7. Call the Agent tool with `subagent_type: "general-purpose"`, `description: "understand-chat: knowledge-graph-guide"`, and a `prompt` that starts with the line `Read ~/.claude/skills/understand/agents/knowledge-graph-guide.md completely and follow it as your instructions.`, followed by these inputs, with the values substituted:
   > Map: `$DATA/knowledge-graph.json` (metadata in `$DATA/meta.json`). Wiki root: `$PROJECT_ROOT`.
   > Question: "$ARGUMENTS"
   > Answer the question from this map. Grep the map first and never load the whole file. Match node names, summaries and tags, follow the matched nodes' 1-hop edges in both directions, say which layers (index categories) they belong to and why, and cite article file paths. If nothing matches, say so and suggest related terms from the map. Reply with the answer only.

   Never read the guide file yourself or paste its text. Give the freshness warning from step 2 first, then the guide's answer, then go to step 8.

4. **Search for relevant nodes**: use Grep to search `$DATA/knowledge-graph.json` for the user's query keywords: "$ARGUMENTS"
   - Search `"name"` fields: `grep -i "query_keyword"` in the graph file
   - Search `"summary"` fields for semantic matches
   - Search `"tags"` arrays for topic matches
   - Note the `id` values of all matching nodes

5. **Find connected edges**: for each matched node ID, Grep for that ID in the `edges` section to find:
   - What it imports or depends on (downstream)
   - What calls or imports it (upstream)
   - This gives you the 1-hop subgraph around the query

6. **Read layer context**: Grep for `"layers"` to understand which architectural layers the matched nodes belong to.

7. **Answer the query** using only the relevant subgraph:
   - Reference specific files, functions, and relationships from the graph
   - Explain which layer(s) are relevant and why
   - Be concise but thorough; link concepts to actual code locations
   - If the query doesn't match any nodes, say so and suggest related terms from the graph

8. **Link the map.** End with one line linking the Understand page, focused on the most relevant node: `http://127.0.0.1:3737/understand?project=$KEY&node=<node id, URL-encoded with encodeURIComponent>`. When nothing matched, link `http://127.0.0.1:3737/understand?project=$KEY` instead.
