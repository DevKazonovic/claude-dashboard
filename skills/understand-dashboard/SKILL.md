---
name: understand-dashboard
description: Open a project's Understand map (the knowledge graph /understand saved in ~/.claude/understand) on the Understand page of claude-dashboard and print the link. Use when the user types /understand-dashboard, or asks to open, show or launch the Understand dashboard or graph view for a project.
argument-hint: "[project-path]"
---

# /understand-dashboard

Open the Understand page of claude-dashboard on the current project's knowledge graph.

Adapted from Understand Anything's `/understand-dashboard` skill (MIT, see `{{CLAUDE_DASHBOARD}}/src/understand/LICENSE-understand-anything`). claude-dashboard replaces Understand Anything's own viewer: one page serves every project under `~/.claude/understand/`, so nothing is installed or built, there is no access token, and nothing is written inside the project.

## Instructions

1. Resolve the project and its data folder. If `$ARGUMENTS` contains a path, use it as the project directory; otherwise use the current working directory. Use the Bash tool:
   ```bash
   PROJECT_ARG="$ARGUMENTS"
   node {{CLAUDE_DASHBOARD}}/src/understand/scripts/data-dir.mjs "${PROJECT_ARG:-.}" \
     | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("DATA="+j.dataDir);console.log("KEY="+j.key)'
   ```
   `data-dir.mjs` prints one JSON line `{"key","dataDir","projectRoot"}` and the `node -e` part parses it (do not rely on `jq`). If the command fails, tell the user `Error: Project directory not found: <path>` with the path you used, and **STOP**. Set `$DATA` and `$KEY` to the printed values.

2. Check that `$DATA/knowledge-graph.json` exists:
   ```bash
   test -f "$DATA/knowledge-graph.json" && echo "graph ok"
   ```
   If it does not print `graph ok`, tell the user:
   ```
   No knowledge graph found. Run /understand first to analyze this project.
   ```
   and **STOP**.

3. Make sure claude-dashboard runs:
   ```bash
   node {{CLAUDE_DASHBOARD}}/bin/claude-dashboard.js status
   ```
   If it says the dashboard is not running, start it in the background without opening a browser. Run this with the Bash tool's `run_in_background: true`: the command waits for the dashboard's transcript scan before it exits, while the server itself runs detached:
   ```bash
   node {{CLAUDE_DASHBOARD}}/bin/claude-dashboard.js start --no-open
   ```
   Then run `status` again until it reports `Running at ...` (give up after about 20 seconds).

4. Report to the user, with the full link:
   ```
   Dashboard: http://127.0.0.1:3737/understand?project=$KEY
   Viewing: $DATA/knowledge-graph.json
   ```
   If `status` reports another port (3737 was taken), use that port in the link. If the dashboard did not come up, say so, give the log path that `status` or `start` printed, and still print the link.

## Notes

- claude-dashboard keeps running in the background after this session. Stop it with `node {{CLAUDE_DASHBOARD}}/bin/claude-dashboard.js stop`.
- The page reloads by itself when the map changes, so after `/understand` (or an auto-update) an open tab shows the new map.
- `http://127.0.0.1:3737/understand` without `?project=` lists every analyzed project.
