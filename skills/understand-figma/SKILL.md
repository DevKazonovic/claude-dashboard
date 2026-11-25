---
name: understand-figma
description: Map a Figma file into a design knowledge graph (pages, screens, components, component sets, variants, instances, design tokens, page layers and a tour) for the claude-dashboard Understand page, reading the file through the connected Figma connector. Use when the user types /understand-figma, or asks to map, analyze or understand a Figma file or design as a graph on the Understand page.
argument-hint: "<figma-file-url-or-key> [--language <lang>]"
---

# /understand-figma

Analyzes a Figma file and produces an interactive design knowledge graph (`kind: "design"`) for the Understand page of claude-dashboard (`http://127.0.0.1:3737/understand`).

The design map is its own project: every file goes to its data folder `$DATA` (`~/.claude/understand/figma-<file name>/`, resolved in Phase 0), never into a code project's folder or any repo. The scripts live in `{{CLAUDE_DASHBOARD}}/src/understand/scripts/`; the agent prompt is `~/.claude/skills/understand/agents/design-analyzer.md`. Adapted from Understand Anything's `/understand-figma` skill (MIT, see `{{CLAUDE_DASHBOARD}}/src/understand/LICENSE-understand-anything`).

## Prerequisites

- The user's Figma connector (tools named `mcp__claude_ai_Figma__*`). Load the ones this skill uses with ToolSearch query `select:mcp__claude_ai_Figma__create_session,mcp__claude_ai_Figma__get_metadata,mcp__claude_ai_Figma__get_variable_defs,mcp__claude_ai_Figma__get_screenshot,mcp__claude_ai_Figma__whoami`. If they do not exist, STOP and tell the user:
  > Connect Figma first (claude.ai Settings, Connectors, Figma), then re-run /understand-figma.
- There is no Figma token: nothing is read from the environment and no credential is written anywhere.
- This skill only reads. Never call `use_figma` or any other Figma tool that creates or changes something.

> **Network:** unlike `/understand`, this skill reads the file from Figma through the connector and downloads screen thumbnails from the short-lived image links the connector returns. Tell the user this once.

## Phase 0: Pre-flight

1. Parse `$ARGUMENTS` for a Figma URL or bare file key (the non-flag token) and an optional `--language <lang>`.
   - `figma.com/design/<fileKey>/<fileName>...` or `figma.com/file/<fileKey>/<fileName>...`: `$FILE_KEY` = `<fileKey>`.
   - `figma.com/design/<fileKey>/branch/<branchKey>/<fileName>`: `$FILE_KEY` = `<branchKey>`.
   - `figma.com/board/`, `/slides/` or `/make/` links: STOP and say only Figma design files (`figma.com/design/...`) can be mapped.
   - A bare key: `$FILE_KEY` = the key.
   - `$FILE_NAME` = the URL's `<fileName>` segment, URL-decoded, dashes turned into spaces (`Shop-App` gives `Shop App`). With a bare key, use the document name if the page list in step 4 shows one, otherwise the key.
2. Check the pipeline:
   ```bash
   test -f {{CLAUDE_DASHBOARD}}/src/understand/scripts/figma-scan.mjs \
     && test -d {{CLAUDE_DASHBOARD}}/node_modules/zod \
     && echo "pipeline ok"
   ```
   If it does not print `pipeline ok`, tell the user the Understand pipeline is missing from claude-dashboard (`{{CLAUDE_DASHBOARD}}/src/understand/`) or its packages are not installed (run `npm install` there), and **STOP**.
3. Call `create_session` with `fileKey: $FILE_KEY` and `description: "Read-only: map this Figma file's pages, screens, components and design tokens into a design knowledge graph shown on a local dashboard."`. Keep the returned UUID as `$SESSION_ID` and pass `sessionId: $SESSION_ID` on every Figma call below.
4. Call `get_metadata` with `fileKey` and `sessionId` only (no `nodeId`): it lists the file's top-level pages (id + name). If a Figma call fails with an access, permission or rate-limit error, call `whoami`, tell the user what it shows, and **STOP**.
5. Resolve the data folder `$DATA` (the same folder for the same file key on every run, even after a rename):
   ```bash
   node {{CLAUDE_DASHBOARD}}/src/understand/scripts/data-dir.mjs --figma "$FILE_KEY" "$FILE_NAME" \
     | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("DATA="+j.dataDir);console.log("KEY="+j.key)'
   ```
   If it fails, relay its stderr and **STOP**. Set `$DATA` and `$KEY` (used for the dashboard link) to the printed values and carry them forward: each command block may run in a fresh shell.
6. Start from a clean intermediate folder (the previous `scan-manifest.json` stays):
   ```bash
   mkdir -p "$DATA/intermediate"
   find "$DATA/intermediate" -mindepth 1 -maxdepth 1 -not -name 'scan-manifest.json' -exec rm -rf {} +
   mkdir -p "$DATA/intermediate/figma"
   ```
7. If `--language` was given, normalize it like `/understand` does (`chinese` → `zh`, `japanese` → `ja`, `french` → `fr`, `arabic` → `ar`, locale variants such as `zh-TW` kept as they are) and store `$LANGUAGE_DIRECTIVE`:
   ```markdown
   > **Language directive**: Generate all textual content (summaries, descriptions, tags, titles, languageNotes, languageLesson) in **{language}**. Maintain technical accuracy while using natural, native-level phrasing in the target language. Keep technical terms in English when no standard translation exists (e.g., "middleware", "hook", "barrel").
   ```
   Without `--language` there is no directive.

## Phase 1: FETCH & PARSE (connector, then deterministic)

The connector's answers are saved as files in `$DATA/intermediate/figma/`, and `figma-scan.mjs` turns them into the same `scan-manifest.json` that Understand Anything's REST scan produced. Save raw tool text with the Write tool. When Claude Code saved a large tool result to a file instead of showing it, copy that file with `cp` (the scan reads plain text and saved JSON tool results alike).

1. Write the page list from Phase 0 step 4 as `$DATA/intermediate/figma/pages.json`, every page in file order: `[{"id": "0:1", "name": "Cover"}, {"id": "12:3", "name": "App"}]`.
2. For every page, call `get_metadata` with `fileKey`, `nodeId: <page id>` and `sessionId` (several pages per message), and save the XML exactly as returned to `$DATA/intermediate/figma/page-<page id with : replaced by ->.xml` (page `12:3` goes to `page-12-3.xml`). Leave out a leading "Currently selected nodes:" block if the tool adds one.
3. Run the first scan:
   ```bash
   node {{CLAUDE_DASHBOARD}}/src/understand/scripts/figma-scan.mjs "$DATA" "$FILE_KEY"
   ```
   If it exits non-zero, relay stderr and **STOP**.
   > If the scan prints `UP_TO_DATE`, report "Design graph is already up to date for this Figma file version", print the dashboard link (Phase 4 step 3), and **STOP**. The connector gives no file version, so the scan compares a hash of the parsed structure (pages, screens, components, sets and instances, with their names and sizes): edits that only change colors, tokens or pixels do not count. To force a full rebuild, re-run with `UNDERSTAND_FIGMA_FORCE=1` set in the environment.

   Otherwise it wrote `$DATA/intermediate/figma/targets.json`: `variableDefs` (node ids) and `screenshots` (`{nodeId, file}` pairs).
4. **Design tokens.** For each id in `variableDefs`, call `get_variable_defs` with `fileKey`, `nodeId` and `sessionId` (about 10 per message). Write all answers as one JSON file `$DATA/intermediate/figma/vars.json`: `{"<nodeId>": {"<variable or style name>": "<value>"}}`. The tool answers in a loose `{'name': value}` form: turn it into real JSON, keep every value's text as it is (`#949494`, `16`, `Font(family: "Inter", ...)`, `Effect(...)`), and give a node with no variables `{}`. Skip a node whose call fails.
5. **Screen thumbnails.** Work through `screenshots` in groups of about 10: call `get_screenshot` with `fileKey`, `nodeId`, `maxDimension: 640` and `sessionId` for the whole group in one message, then download that group in one Bash command right away (the links expire), each PNG straight to its entry's `file` (`$DATA/thumbnails/<safe-id>.png`): use the download command the tool gives, or `curl -sSfL --max-time 60 -o "<file>" "<url>"`. Never set `enableBase64Response` and never save images anywhere else. Skip failures: thumbnails are optional.
6. Run the same scan command again. It now adds the tokens (`uses_token` edges) and the thumbnails (a download that is not a PNG is deleted; each kept screen gets `figmaMeta.thumbnailUrl` pointing at the dashboard's thumbnail route), rewrites `scan-manifest.json`, and writes `$DATA/intermediate/design-batches.json`. Relay the printed counts to the user.

## Phase 2: ANALYZE (LLM enrichment)

1. `design-batches.json` holds the batches (about 15 nodes each, grouped by page, with each node's child names and token usage) and the full list of node ids. The scan printed the batch count `T`.
2. For each batch `N` (1 to `T`), dispatch a subagent: the Agent tool with `subagent_type: "general-purpose"`, `description: "understand-figma: design-analyzer N/T"` and the prompt below, with real paths and numbers written in. Never read or paste the agent file yourself, and pass no `model`.
   ```
   Read ~/.claude/skills/understand/agents/design-analyzer.md completely and follow it as your instructions. The values below fill its $DATA, $BATCH_NUM and $INTERMEDIATE_DIR.

   $DATA = <DATA>
   $BATCH_NUM = <N>
   $INTERMEDIATE_DIR = <DATA>/intermediate
   ```
   followed by `$LANGUAGE_DIRECTIVE` if `--language` was provided. The agent writes `analysis-batch-<N>.json`.
3. Run up to **5 batches concurrently** (several Agent calls in one message). If a batch fails, log a warning and continue: the manifest is a solid base.

## Phase 3: MERGE

```bash
node {{CLAUDE_DASHBOARD}}/src/understand/scripts/figma-merge.mjs "$DATA"
```

It combines `scan-manifest.json` + `analysis-batch-*.json`, runs `mergeDesignGraph` (validates, re-attaches `kind: "design"`, builds one layer per page plus a Design System layer, and the tour), and writes `$DATA/knowledge-graph.json` + `$DATA/meta.json`. Relay the printed stats and any non-`auto-corrected` issues. If it exits non-zero, relay stderr and **STOP**.

## Phase 4: SAVE & LAUNCH

1. Clean up intermediate files **except** `scan-manifest.json`:
   ```bash
   find "$DATA/intermediate" -mindepth 1 -maxdepth 1 -not -name 'scan-manifest.json' -exec rm -rf {} +
   ```
2. Report a summary: project name, counts by node type, edges by type, layers, tour steps, thumbnails saved, and the path `$DATA/knowledge-graph.json`. This prints them without loading the graph into the conversation:
   ```bash
   node -e 'const g=require(process.argv[1]);const c=a=>a.reduce((m,x)=>(m[x.type]=(m[x.type]||0)+1,m),{});console.log(JSON.stringify({project:g.project.name,nodes:c(g.nodes),edges:c(g.edges),layers:g.layers.map(l=>l.name),tourSteps:g.tour.length,thumbnails:g.nodes.filter(n=>n.figmaMeta&&n.figmaMeta.thumbnailUrl).length},null,1))' "$DATA/knowledge-graph.json"
   ```
3. Make sure claude-dashboard runs and give the link:
   ```bash
   node {{CLAUDE_DASHBOARD}}/bin/claude-dashboard.js status
   ```
   If it says the dashboard is not running, start it with the Bash tool's `run_in_background: true` (the command waits for the dashboard's transcript scan, while the server itself runs detached):
   ```bash
   node {{CLAUDE_DASHBOARD}}/bin/claude-dashboard.js start --no-open
   ```
   Then run `status` again until it reports `Running at ...` (give up after about 20 seconds). Print `http://127.0.0.1:3737/understand?project=$KEY`. If `status` reports another port (3737 was taken), use that port in the link. If the dashboard does not come up, say so, give the log path `status` or `start` printed, and still print the link.
