---
name: godeye
description: Design a new feature before any code by brainstorming it with the user as diagrams, one level at a time (idea, flow, system, parts, logic, build slices), in plain words. Writes one GodEye design file in the one schema (assets/schema.json) that the GodEye page of claude-dashboard shows live as clickable sheets you zoom into. Use it when the user types /godeye, or wants to brainstorm, plan or design a feature as diagrams before coding, even when they do not name the format. Not for documenting existing code, UI wireframes or slide decks.
argument-hint: <the feature to design>
---

# godeye

The user designs by looking. Before any code, you and the user brainstorm the new feature as diagrams, one level at a time, in plain words. You write one JSON design file; the GodEye page of claude-dashboard draws it and reloads by itself when the file changes. Never write HTML.

## Zero code

- Never read code to make the diagrams. Draw from the user's words and the brainstorm.
- Never put code names in a diagram: no file, function, class, table, route or variable names. Name things the way the user would ("Message box", not the component's file name). `check.py` flags text that looks like code.

## The levels

| Sheet | Level | It answers | Boxes |
|---|---|---|---|
| 1 | Idea | Who uses it, the problem, what done looks like, and the outside systems. | one `feature`, `person`, `outside`, `store` |
| 2 | Flow | What the user does, step by step. | `start`, `step`, `decision`, `end`, `stop` |
| 3 | System | Which parts do the work and what moves between them. | `person`, `app`, `service`, `store`, `outside` |
| 3.N | Parts | Inside one app or service: its pieces and which piece uses which. | `part`, `store` |
| 3.N.M | Logic | One hard piece as a flowchart in plain words: steps, yes/no, loops. | `start`, `step`, `decision`, `end`, `stop`, `question` |
| 4 | Build | The slices Claude builds one at a time, each checked against its sheets. | `slice` |

An `app` or `service` box on sheet 3 opens its parts sheet 3.N with `opens`; a `part` on sheet 3.N opens its logic sheet 3.N.M. The feature box on sheet 1 may open sheet 2.

## One level per OK

1. Draw one sheet with `"status": "draft"`.
2. Write the file and run the check. Fix every problem before the user sees it.
3. Give the link `http://127.0.0.1:3737/godeye?project=<project>&map=<id>&sheet=<sheet id>` and two or three short lines: what the sheet shows and its open questions. Then wait.
4. On "ok", set that sheet to `"approved"` and go one level deeper. On a change, redraw that sheet only, keep it `draft`, and link it again.

Never draw several levels at once. Open questions go in the box's `questions` and get answered before going deeper.

## Depth follows size

- Small change: sheet 1 with only the feature box, then the flow.
- Medium feature: idea, flow, system.
- Big feature: every level. Draw logic sheets only for the risky steps.

## Rules

- Plain words only. No em or en dashes. Never cut text with ... or a character limit; the page wraps it.
- At most 7 work boxes (apps, services, parts, steps, slices) per sheet. When a sheet needs more, group some into one box that opens its own sheet.
- A parts sheet keeps the connections of the box that opens it. Every line that touches that box on sheet 3 shows up on the parts sheet as a port, written `^` plus the other box's id, in the same direction: `{ "from": "^page", "to": "run" }` when sheet 3 has page to server. The page draws ports at the sheet's edges.
- Boxes sit on a grid: `at` is `[column, row]`, whole numbers from 0, one box per cell. Put boxes where a reader expects them: the flow left to right, a request top to bottom. The page spaces the grid and draws every line.
- `main` lines on sheet 3 trace one request and carry `order` 1, 2, 3 and so on. Yes and no lines start at a decision.
- Details per box are optional, a few words each: `note` (under the name), `does`, `gets`, `gives`, `rules`, `questions`, `see` (other boxes as `sheet/box`, for example `3.2/run`). The feature box adds `done` and `out` (not in this feature).
- `status` on a sheet is `draft` until the user says ok to it, then `approved`.

## The file

- It lives at `~/.claude/godeye/<project>/<id>.json`. `<id>` is kebab-case, such as `playground-per-channel`. Create the project folder when it is missing. Writing the file is enough: the page picks it up.
- Start from `assets/template.json`.
- Check after every write: `python3 -I <skill-dir>/scripts/check.py <file>`. It prints `ok: ...` or one `sheet/box: problem` line per problem.

## Build slices

- Once the sheets are approved, sheet 4 lists one `slice` per flow step, with `from` (the boxes it is built from, as `sheet/box`) and `check` (what to verify on the result).
- Build one slice at a time, and only when the user says so. Set its `status` to `building`, then `built` after checking the code against the slice's sheets.
- When the code needs the design to change, change the sheet first, get the OK, then change the code. The sheets stay the truth.

## Files

- `assets/schema.json`: the one format. Levels, kinds, lines, fields, limits and rules.
- `assets/template.json`: the empty file, sheet 1 with one feature box.
- `scripts/check.py`: the check.
