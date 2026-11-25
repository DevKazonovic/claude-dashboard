import json
import re
import sys
from pathlib import Path

SCHEMA = Path(__file__).resolve().parent.parent / "assets" / "schema.json"
DASHES = ("—", "–")
CODE = (
    (re.compile(r"\(\)"), "()"),
    (re.compile(r"::"), "::"),
    (re.compile(r"->"), "->"),
    (re.compile(r"=>"), "=>"),
    (re.compile(r"`"), "a backtick"),
    (re.compile(r"[{}]"), "curly braces"),
    (re.compile(r"\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b"), "a snake_case name"),
    (re.compile(r"\w\.(php|py|ts|tsx|js|jsx|vue|go|rb|java|sql)\b", re.I), "a code file name"),
)


def integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def dashed(value):
    return any(dash in json.dumps(value, ensure_ascii=False) for dash in DASHES)


def parent_of(sheet_id):
    if sheet_id == "1":
        return None
    return sheet_id.rsplit(".", 1)[0] if "." in sheet_id else "1"


def plural(count, word, many=None):
    return f"{count} {word if count == 1 else many or word + 's'}"


class Checker:
    def __init__(self, schema):
        self.schema = schema
        self.levels = schema["levels"]
        self.kinds = schema["kinds"]
        self.line_kinds = schema["lines"]
        self.limits = schema["limits"]
        self.box_id = re.compile(schema["box"]["id"])
        self.ref = re.compile(schema["box"]["ref"])
        self.port = re.compile(schema["line"]["port"])
        self.problems = []
        self.sheets = {}

    def say(self, where, text):
        self.problems.append(f"{where}: {text}")

    def words(self, where, field, value):
        if not isinstance(value, str) or not value.strip():
            self.say(where, f"{field} is empty")
            return
        text = value.strip()
        if text.endswith("...") or "…" in text:
            self.say(where, f"{field} is cut with ...; write it in full")
        for pattern, name in CODE:
            if pattern.search(text):
                self.say(where, f"{field} has {name}; use plain words, zero code")
                break

    def fields(self, where, item, rules):
        for field in item:
            if field not in rules["fields"]:
                self.say(where, f"unknown field {field}")
        for field in rules["required"]:
            if field not in item:
                self.say(where, f"{field} is missing")
        for field, value in item.items():
            if field not in ("boxes", "lines", "sheets") and dashed(value):
                self.say(where, f"em or en dash in {field}")

    def file(self, data):
        self.fields("file", data, self.schema["file"])
        self.words("file", "feature", data.get("feature"))
        for field in ("product", "summary"):
            if field in data:
                self.words("file", field, data[field])
        sheets = data.get("sheets")
        if not isinstance(sheets, list) or not sheets:
            self.say("file", "sheets must be a list with sheet 1 in it")
            return []
        if len(sheets) > self.limits["sheets"]:
            self.say("file", f"{len(sheets)} sheets, over {self.limits['sheets']}")
        return sheets

    def sheet(self, sheet, index):
        if not isinstance(sheet, dict):
            self.say(f"sheets[{index}]", "sheet is not an object")
            return
        sheet_id = sheet.get("id")
        where = sheet_id if isinstance(sheet_id, str) and sheet_id else f"sheets[{index}]"
        self.fields(where, sheet, self.schema["sheet"])
        if not isinstance(sheet_id, str) or not sheet_id:
            self.say(where, "id is not text")
            return
        if sheet_id in self.sheets:
            self.say(where, "duplicate sheet id")
            return
        level = sheet.get("level")
        rules = self.levels.get(level) if isinstance(level, str) else None
        if rules is None:
            self.say(where, f"unknown level {level}")
        elif not re.match(rules["sheet"], sheet_id):
            self.say(where, f"id {sheet_id} is not a {level} sheet id")
        self.words(where, "title", sheet.get("title"))
        if sheet.get("status") not in self.schema["sheet"]["status"]:
            self.say(where, f"status must be one of {', '.join(self.schema['sheet']['status'])}")
        if "note" in sheet:
            self.words(where, "note", sheet["note"])
        boxes = sheet.get("boxes")
        lines = sheet.get("lines", [])
        if not isinstance(boxes, list):
            self.say(where, "boxes is not a list")
            boxes = []
        if not isinstance(lines, list):
            self.say(where, "lines is not a list")
            lines = []
        found = {"level": level if rules else None, "data": sheet, "boxes": {}, "lines": []}
        self.sheets[sheet_id] = found
        taken = {}
        work = 0
        for box_index, box in enumerate(boxes):
            made = self.box(sheet_id, found["level"], box, box_index, taken)
            if made is None:
                continue
            box_id, kind = made
            if box_id in found["boxes"]:
                self.say(f"{sheet_id}/{box_id}", "duplicate box id")
                continue
            found["boxes"][box_id] = box
            if self.kinds.get(kind, {}).get("work"):
                work += 1
        if len(boxes) > self.limits["boxes"]:
            self.say(where, f"{len(boxes)} boxes, over {self.limits['boxes']}")
        if work > self.limits["work"]:
            self.say(where, f"{work} work boxes, over {self.limits['work']}; group some into one box that opens its own sheet")
        if len(lines) > self.limits["lines"]:
            self.say(where, f"{len(lines)} lines, over {self.limits['lines']}")
        for line_index, line in enumerate(lines):
            label = f"{sheet_id}/line {line_index + 1}"
            if not isinstance(line, dict):
                self.say(label, "line is not an object")
                continue
            self.fields(label, line, self.schema["line"])
            found["lines"].append((label, line))

    def box(self, sheet_id, level, box, index, taken):
        rules = self.schema["box"]
        if not isinstance(box, dict):
            self.say(f"{sheet_id}/boxes[{index}]", "box is not an object")
            return None
        box_id = box.get("id")
        where = f"{sheet_id}/{box_id}" if isinstance(box_id, str) and box_id else f"{sheet_id}/boxes[{index}]"
        self.fields(where, box, rules)
        if not isinstance(box_id, str) or not self.box_id.match(box_id):
            self.say(where, "id must be kebab-case")
            return None
        kind = box.get("kind")
        if kind not in self.kinds:
            self.say(where, f"unknown kind {kind}")
        elif level and kind not in self.levels[level]["kinds"]:
            self.say(where, f"kind {kind} is not allowed on a {level} sheet")
        self.words(where, "name", box.get("name"))
        for field in rules["text"]:
            if field != "name" and field in box:
                self.words(where, field, box[field])
        for field in rules["lists"]:
            if field not in box:
                continue
            items = box[field]
            if not isinstance(items, list) or not items:
                self.say(where, f"{field} must be a list with at least one line")
                continue
            for item in items:
                self.words(where, f"a line in {field}", item)
        for field in rules["refs"]:
            if field not in box:
                continue
            items = box[field]
            if not isinstance(items, list) or not items:
                self.say(where, f"{field} must be a list of sheet/box")
                continue
            for item in items:
                if not isinstance(item, str) or not self.ref.match(item):
                    self.say(where, f"{field} item {item} is not sheet/box")
        for field, owners in rules["only"].items():
            if field in box and kind not in owners:
                self.say(where, f"{field} is only for {', '.join(owners)} boxes")
        if "status" in box and box["status"] not in rules["status"]:
            self.say(where, f"status must be one of {', '.join(rules['status'])}")
        if "opens" in box and not isinstance(box["opens"], str):
            self.say(where, "opens is not a sheet id")
        at = box.get("at")
        grid = self.limits["grid"]
        if not (isinstance(at, list) and len(at) == 2 and all(integer(value) and 0 <= value < grid for value in at)):
            self.say(where, f"at must be [column, row], whole numbers 0 to {grid - 1}")
        else:
            cell = tuple(at)
            if cell in taken:
                self.say(where, f"at [{at[0]}, {at[1]}] is already taken by {taken[cell]}")
            else:
                taken[cell] = box_id
        return box_id, kind

    def tree(self):
        if "1" not in self.sheets:
            self.say("file", "sheet 1 (the idea) is missing")
        else:
            features = [box_id for box_id, box in self.sheets["1"]["boxes"].items() if box.get("kind") == "feature"]
            if len(features) != 1:
                self.say("1", f"needs exactly one feature box, found {len(features)}")
        for sheet_id in self.sheets:
            parent = parent_of(sheet_id)
            if parent is not None and parent not in self.sheets:
                self.say(sheet_id, f"its parent sheet {parent} is missing")
        openers = {}
        for sheet_id, sheet in self.sheets.items():
            for box_id, box in sheet["boxes"].items():
                target = box.get("opens")
                if not isinstance(target, str):
                    continue
                where = f"{sheet_id}/{box_id}"
                child = self.sheets.get(target)
                if child is None:
                    self.say(where, f"opens sheet {target}, which does not exist")
                    continue
                kind = box.get("kind")
                allowed = "flow" if kind == "feature" else self.kinds.get(kind, {}).get("opens")
                if parent_of(target) != sheet_id or child["level"] != allowed:
                    self.say(where, f"a {kind} box on sheet {sheet_id} cannot open sheet {target}")
                    continue
                openers.setdefault(target, []).append(box_id)
        for sheet_id, sheet in self.sheets.items():
            if sheet["level"] not in ("parts", "logic"):
                continue
            found = openers.get(sheet_id, [])
            if len(found) != 1:
                self.say(sheet_id, f"must be opened by exactly one box on sheet {parent_of(sheet_id)}, found {len(found)}")
            else:
                sheet["opener"] = found[0]

    def lines(self):
        for sheet_id, sheet in self.sheets.items():
            level = sheet["level"]
            allowed = self.levels[level]["lines"] if level else list(self.line_kinds)
            orders = []
            for where, line in sheet["lines"]:
                kind = line.get("kind", "plain")
                if kind not in self.line_kinds:
                    self.say(where, f"unknown line kind {kind}")
                elif kind not in allowed:
                    self.say(where, f"line kind {kind} is not allowed on a {level} sheet")
                if "label" in line:
                    self.words(where, "label", line["label"])
                if "both" in line and not isinstance(line["both"], bool):
                    self.say(where, "both must be true or false")
                if self.line_kinds.get(kind, {}).get("order"):
                    order = line.get("order")
                    if integer(order) and order >= 1:
                        orders.append(order)
                    else:
                        self.say(where, f"a {kind} line needs order, a whole number from 1")
                elif "order" in line:
                    self.say(where, f"only main lines carry order, this one is {kind}")
                ends = [line.get("from"), line.get("to")]
                for end in ends:
                    if not isinstance(end, str) or not end:
                        self.say(where, "from and to must be box ids")
                    elif end.startswith("^"):
                        if level != "parts":
                            self.say(where, f"port {end} is only allowed on a parts sheet")
                        elif not self.port.match(end):
                            self.say(where, f"port {end} must be ^ plus a box id")
                    elif end not in sheet["boxes"]:
                        self.say(where, f"{end}: no such box on sheet {sheet_id}")
                if all(isinstance(end, str) and end.startswith("^") for end in ends):
                    self.say(where, "a line must touch a box on this sheet")
                if isinstance(ends[0], str) and ends[0] == ends[1]:
                    self.say(where, f"line from {ends[0]} to itself")
                if kind in ("yes", "no"):
                    start = sheet["boxes"].get(ends[0]) if isinstance(ends[0], str) else None
                    if start is None or start.get("kind") != "decision":
                        self.say(where, f"a {kind} line must start at a decision")
            if sorted(orders) != list(range(1, len(orders) + 1)):
                self.say(sheet_id, f"main lines must be numbered 1 to {len(orders)}, found {', '.join(map(str, sorted(orders)))}")

    def balance(self):
        system = self.sheets.get("3")
        for sheet_id, sheet in self.sheets.items():
            opener = sheet.get("opener")
            if sheet["level"] != "parts" or opener is None or system is None:
                continue
            need = {}
            for _, line in system["lines"]:
                start, end, both = line.get("from"), line.get("to"), line.get("both") is True
                if start == opener and isinstance(end, str):
                    need.setdefault(end, set()).add("any" if both else "out")
                if end == opener and isinstance(start, str):
                    need.setdefault(start, set()).add("any" if both else "in")
            have = {}
            for _, line in sheet["lines"]:
                start, end = line.get("from"), line.get("to")
                if isinstance(start, str) and start.startswith("^"):
                    have.setdefault(start[1:], set()).add("in")
                if isinstance(end, str) and end.startswith("^"):
                    have.setdefault(end[1:], set()).add("out")
            for other in have:
                if other not in system["boxes"]:
                    self.say(sheet_id, f"port ^{other}: no box {other} on sheet 3")
                elif other not in need:
                    self.say(sheet_id, f"port ^{other}: {other} is not connected to {opener} on sheet 3")
            for other, ways in need.items():
                got = have.get(other, set())
                if "in" in ways and "in" not in got:
                    self.say(sheet_id, f"needs a line from ^{other} into this sheet (sheet 3 has {other} to {opener})")
                if "out" in ways and "out" not in got:
                    self.say(sheet_id, f"needs a line from this sheet to ^{other} (sheet 3 has {opener} to {other})")
                if "any" in ways and not got:
                    self.say(sheet_id, f"needs a line to or from ^{other} (sheet 3 links {opener} and {other})")

    def refs(self):
        for sheet_id, sheet in self.sheets.items():
            for box_id, box in sheet["boxes"].items():
                for field in self.schema["box"]["refs"]:
                    items = box.get(field)
                    if not isinstance(items, list):
                        continue
                    for item in items:
                        if not isinstance(item, str) or not self.ref.match(item):
                            continue
                        target_sheet, target_box = item.split("/")
                        target = self.sheets.get(target_sheet)
                        if target is None or target_box not in target["boxes"]:
                            self.say(f"{sheet_id}/{box_id}", f"{field} {item}: no such box")

    def summary(self):
        counts = {}
        for sheet in self.sheets.values():
            counts[sheet["level"]] = counts.get(sheet["level"], 0) + 1
        levels = []
        for level in self.schema["order"]:
            count = counts.get(level, 0)
            if count == 1:
                levels.append(level)
            elif count > 1:
                levels.append(f"{count} {level}")
        boxes = sum(len(sheet["boxes"]) for sheet in self.sheets.values())
        drafts = sum(1 for sheet in self.sheets.values() if sheet["data"].get("status") == "draft")
        questions = sum(len(box.get("questions") or []) for sheet in self.sheets.values() for box in sheet["boxes"].values())
        return f"ok: {plural(len(self.sheets), 'sheet')} ({', '.join(levels)}), {plural(boxes, 'box', 'boxes')}, {plural(drafts, 'draft')}, {plural(questions, 'open question')}"


def main(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"cannot read: {error}")
        return 1
    version = data.get("godeye") if isinstance(data, dict) else None
    if version in (1, 2, 3):
        print("old format: run /godeye again")
        return 1
    if version != schema["godeye"]:
        print(f'not a godeye file: "godeye": {schema["godeye"]} is missing')
        return 1

    checker = Checker(schema)
    for index, sheet in enumerate(checker.file(data)):
        checker.sheet(sheet, index)
    checker.tree()
    checker.lines()
    checker.balance()
    checker.refs()

    if checker.problems:
        for problem in checker.problems:
            print(problem)
        return 1
    print(checker.summary())
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python3 -I check.py <design.json>")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
