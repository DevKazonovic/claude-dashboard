#!/usr/bin/env node
/**
 * merge-batch-graphs.mjs — Merge and normalize batch analysis results.
 *
 * Combines batch-*.json files from the intermediate directory into a single
 * assembled graph with normalized IDs, complexity values, and cleaned edges.
 *
 * Called at the end of Phase 2 of /understand. Phase 3 (ASSEMBLE REVIEW)
 * then reviews the output for semantic issues the script cannot catch.
 *
 * Usage:
 *     node merge-batch-graphs.mjs <project-root>
 *
 * Input/output live under the project's data dir (resolveUaDir):
 *     Input:  <ua-dir>/intermediate/batch-*.json
 *     Output: <ua-dir>/intermediate/assembled-graph.json
 */

import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { resolveUaDir } from '../core/index.js';

export class PyFloat {
  constructor(v) {
    this.v = v;
  }

  valueOf() {
    return this.v;
  }
}

export class PyError extends Error {}

export const err = (line = '') => writeSync(2, `${line}\n`);
export const pad = (n) => String(n).padStart(4);

export const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof PyFloat);
const isNum = (v) => ['number', 'bigint', 'boolean'].includes(typeof v) || v instanceof PyFloat;
const isFloat = (v) => v instanceof PyFloat || (typeof v === 'number' && !Number.isInteger(v));
export const pyType = (v) => (v === null || v === undefined ? 'NoneType' : typeof v === 'boolean' ? 'bool' : isFloat(v) ? 'float' : isNum(v) ? 'int' : typeof v === 'string' ? 'str' : Array.isArray(v) ? 'list' : 'dict');

export function get(o, k, d = null) {
  if (!isDict(o)) throw new TypeError(`'${pyType(o)}' object has no attribute 'get'`);
  return Object.hasOwn(o, k) ? o[k] : d;
}

export function truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (isNum(v)) return Number(v) !== 0;
  if (typeof v === 'string' || Array.isArray(v)) return v.length > 0;
  return typeof v !== 'object' || Object.keys(v).length > 0;
}

function floatRepr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const sign = x < 0 || Object.is(x, -0) ? '-' : '';
  const [m, e] = Math.abs(x).toExponential().split('e');
  const digits = m.replace('.', '');
  const exp = Number(e);
  if (exp < -4 || exp >= 16) return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  return `${sign}${digits.slice(0, exp + 1).padEnd(exp + 1, '0')}.${digits.slice(exp + 1) || '0'}`;
}

const REPR_ESCAPES = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };

function strRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/[\\\t\n\r'"]|(?! )[\p{C}\p{Z}]/gu, (c) => {
    if (REPR_ESCAPES[c]) return REPR_ESCAPES[c];
    if (c === "'" || c === '"') return c === q ? `\\${c}` : c;
    const cp = c.codePointAt(0);
    const h = cp.toString(16);
    return cp < 0x100 ? `\\x${h.padStart(2, '0')}` : cp < 0x10000 ? `\\u${h.padStart(4, '0')}` : `\\U${h.padStart(8, '0')}`;
  }) + q;
}

export function pyRepr(v) {
  if (typeof v === 'string') return strRepr(v);
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (isFloat(v)) return floatRepr(Number(v));
  if (isNum(v)) return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  return `{${Object.keys(v).map((k) => `${strRepr(k)}: ${pyRepr(v[k])}`).join(', ')}}`;
}

export const pyStr = (v) => (typeof v === 'string' ? v : pyRepr(v));

let nanSeq = 0;
export function pyKey(v) {
  if (typeof v === 'string') return `s${v}`;
  if (v === null) return 'N';
  if (!isNum(v)) throw new TypeError(`unhashable type: '${pyType(v)}'`);
  if (typeof v === 'bigint') return `n${v}`;
  const x = Number(v);
  if (Number.isNaN(x)) return `nan${nanSeq++}`;
  return `n${Number.isInteger(x) ? BigInt(x) : x}`;
}

export function has(coll, v) {
  pyKey(v);
  return typeof v === 'string' && coll.has(v);
}

export function pyEq(a, b) {
  if (isNum(a) && isNum(b)) return pyKey(a) === pyKey(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && pyEq(a[k], b[k]));
  }
  return a === b;
}

export function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return [...v];
  if (isDict(v)) return Object.keys(v);
  throw new TypeError(`'${pyType(v)}' object is not iterable`);
}

export function pyLen(v) {
  if (typeof v === 'string') return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (isDict(v)) return Object.keys(v).length;
  throw new TypeError(`object of type '${pyType(v)}' has no len()`);
}

export function pyContains(container, item) {
  if (Array.isArray(container)) return container.some((x) => pyEq(x, item));
  if (typeof container === 'string') {
    if (typeof item !== 'string') throw new TypeError(`'in <string>' requires string as left operand, not ${pyType(item)}`);
    return container.includes(item);
  }
  if (isDict(container)) return has({ has: (k) => Object.hasOwn(container, k) }, item);
  throw new TypeError(`argument of type '${pyType(container)}' is not iterable`);
}

export class Counter extends Map {
  add(k) {
    const key = pyKey(k);
    const entry = this.get(key);
    if (entry) entry[1] += 1;
    else this.set(key, [k, 1]);
  }

  mostCommon() {
    return [...this.values()].sort((a, b) => b[1] - a[1]);
  }

  total() {
    let t = 0;
    for (const [, c] of this.values()) t += c;
    return t;
  }
}

const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const pyStrip = (s) => s.replace(PY_STRIP_RE, '');
const FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?$/;

export function num(v) {
  if (typeof v === 'string') {
    const t = pyStrip(v);
    if (FLOAT_RE.test(t)) return Number(t.replaceAll('_', ''));
    const m = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
    if (!m) return 0;
    return m[2].toLowerCase() === 'nan' ? NaN : m[1] === '-' ? -Infinity : Infinity;
  }
  return isNum(v) ? Number(v) : 0;
}

export function pyResolve(p) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(pyResolve(parent), basename(abs));
  }
}

const stat = (p) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};
export const isDir = (p) => stat(p)?.isDirectory() ?? false;
const isFile = (p) => stat(p)?.isFile() ?? false;

const STRERROR = {
  EPERM: 'Operation not permitted',
  ENOENT: 'No such file or directory',
  EIO: 'Input/output error',
  EACCES: 'Permission denied',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  ELOOP: 'Too many levels of symbolic links',
  ENAMETOOLONG: 'File name too long',
};

function readText(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch (e) {
    if (!e.code || constants.errno[e.code] === undefined) throw e;
    throw new PyError(`[Errno ${constants.errno[e.code]}] ${STRERROR[e.code] ?? e.message}: ${strRepr(path)}`);
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf).replace(/\r\n?/g, '\n');
}

class Stop {
  constructor(i) {
    this.i = i;
  }
}

const JSON_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const JSON_CONSTS = [['null', null], ['true', true], ['false', false], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]];

export function loads(s) {
  const n = s.length;
  const fail = (msg, pos) => {
    const before = s.slice(0, pos);
    const cp = [...before].length;
    const nl = before.lastIndexOf('\n');
    const col = nl === -1 ? cp + 1 : cp - [...before.slice(0, nl)].length;
    return new PyError(`${msg}: line ${before.split('\n').length} column ${col} (char ${cp})`);
  };
  if (s.startsWith('﻿')) throw fail('Unexpected UTF-8 BOM (decode using utf-8-sig)', 0);
  const ws = (i) => {
    while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
    return i;
  };
  const digit = (i) => i < n && s[i] >= '0' && s[i] <= '9';
  const string = (end) => {
    const begin = end - 1;
    let out = '';
    for (;;) {
      let j = end;
      while (j < n && s[j] !== '"' && s[j] !== '\\') {
        if (s[j] <= '\x1f') throw fail('Invalid control character at', j);
        j++;
      }
      if (j >= n) throw fail('Unterminated string starting at', begin);
      out += s.slice(end, j);
      if (s[j] === '"') return [out, j + 1];
      j++;
      if (j === n) throw fail('Unterminated string starting at', begin);
      if (s[j] !== 'u') {
        const c = JSON_ESCAPES[s[j]];
        if (c === undefined) throw fail('Invalid \\escape', j - 1);
        out += c;
        end = j + 1;
      } else {
        end = j + 5;
        if (end >= n || !/^[0-9a-fA-F]{4}$/.test(s.slice(j + 1, end))) throw fail('Invalid \\uXXXX escape', j);
        out += String.fromCharCode(parseInt(s.slice(j + 1, end), 16));
      }
    }
  };
  const number = (start) => {
    let i = start;
    let float = false;
    if (s[i] === '-' && ++i >= n) throw new Stop(start);
    if (s[i] >= '1' && s[i] <= '9') {
      i++;
      while (digit(i)) i++;
    } else if (s[i] === '0') i++;
    else throw new Stop(start);
    if (i < n - 1 && s[i] === '.' && digit(i + 1)) {
      float = true;
      i += 2;
      while (digit(i)) i++;
    }
    if (i < n - 1 && (s[i] === 'e' || s[i] === 'E')) {
      const e = i++;
      if (i < n - 1 && (s[i] === '-' || s[i] === '+')) i++;
      while (digit(i)) i++;
      if (s[i - 1] >= '0' && s[i - 1] <= '9') float = true;
      else i = e;
    }
    const lit = s.slice(start, i);
    const v = Number(lit);
    if (float) return [Number.isInteger(v) ? new PyFloat(v) : v, i];
    return [Number.isSafeInteger(v) ? v || 0 : BigInt(lit), i];
  };
  const object = (i) => {
    // ponytail: integer-like keys enumerate first in JS objects (Python keeps insertion order); move to Map if a real file path ever hits it
    const o = {};
    i = ws(i);
    if (i >= n || s[i] !== '}') {
      for (;;) {
        if (i >= n || s[i] !== '"') throw fail('Expecting property name enclosed in double quotes', i);
        let k;
        let v;
        [k, i] = string(i + 1);
        i = ws(i);
        if (i >= n || s[i] !== ':') throw fail("Expecting ':' delimiter", i);
        [v, i] = scan(ws(i + 1));
        if (k === '__proto__') Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
        else o[k] = v;
        i = ws(i);
        if (i < n && s[i] === '}') break;
        if (i >= n || s[i] !== ',') throw fail("Expecting ',' delimiter", i);
        const comma = i;
        i = ws(i + 1);
        if (i < n && s[i] === '}') throw fail('Illegal trailing comma before end of object', comma);
      }
    }
    return [o, i + 1];
  };
  const array = (i) => {
    const a = [];
    i = ws(i);
    if (i >= n || s[i] !== ']') {
      for (;;) {
        let v;
        [v, i] = scan(i);
        a.push(v);
        i = ws(i);
        if (i < n && s[i] === ']') break;
        if (i >= n || s[i] !== ',') throw fail("Expecting ',' delimiter", i);
        const comma = i;
        i = ws(i + 1);
        if (i < n && s[i] === ']') throw fail('Illegal trailing comma before end of array', comma);
      }
    }
    return [a, i + 1];
  };
  const scan = (i) => {
    if (i >= n) throw new Stop(i);
    if (s[i] === '"') return string(i + 1);
    if (s[i] === '{') return object(i + 1);
    if (s[i] === '[') return array(i + 1);
    for (const [lit, v] of JSON_CONSTS) if (s.startsWith(lit, i)) return [v, i + lit.length];
    return number(i);
  };
  let v;
  let end;
  try {
    [v, end] = scan(ws(0));
  } catch (e) {
    if (e instanceof Stop) throw fail('Expecting value', e.i);
    throw e;
  }
  end = ws(end);
  if (end !== n) throw fail('Extra data', end);
  return v;
}

export const loadJson = (path) => loads(readText(path));

const jsonStr = (v) => (/\p{Cs}/u.test(v) ? `"${v.replace(/[\x00-\x1f\\"]/g, (c) => JSON.stringify(c).slice(1, -1))}"` : JSON.stringify(v));

export function dumps(v, indent = '') {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (typeof v === 'string') return jsonStr(v);
  if (isFloat(v)) {
    const x = Number(v);
    return Number.isNaN(x) ? 'NaN' : x === Infinity ? 'Infinity' : x === -Infinity ? '-Infinity' : floatRepr(x);
  }
  if (typeof v === 'number') return String(v);
  const inner = `${indent}  `;
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + dumps(x, inner)).join(',\n')}\n${indent}]` : '[]';
  const keys = Object.keys(v);
  return keys.length ? `{\n${keys.map((k) => `${inner}${jsonStr(k)}: ${dumps(v[k], inner)}`).join(',\n')}\n${indent}}` : '{}';
}

export function writeText(path, text) {
  const bad = /\p{Cs}/u.test(text);
  writeFileSync(path, bad ? '' : text);
  if (bad) throw new TypeError("'utf-8' codec can't encode characters: surrogates not allowed");
}

export function kb(path) {
  const q = statSync(path).size / 1024;
  const f = Math.floor(q);
  const d = q - f;
  return d > 0.5 || (d === 0.5 && f % 2 === 1) ? f + 1 : f;
}

function dictGet(map, key, d) {
  return has(map, key) ? map.get(key) : d;
}

// ── Configuration ─────────────────────────────────────────────────────────

const VALID_NODE_PREFIXES = new Set([
  'file', 'func', 'function', 'class', 'module', 'concept',
  'config', 'document', 'service', 'table', 'endpoint',
  'pipeline', 'schema', 'resource',
  'domain', 'flow', 'step',
  // Knowledge-base node types (schema.ts NodeType enum)
  'article', 'entity', 'topic', 'claim', 'source',
]);

// Precompiled once at import time. The previous inline form rebuilt and
// re-escaped this 24-alternative pattern *string* on every node (the regex
// cache keys on the final string, so only the compile was cached — the
// join + re.escape work was not). Benchmarked ~15x faster on large graphs.
// The `:`-delimited group + anchoring makes alternation order (and hence the
// unordered-set iteration order) irrelevant to matching, so hoisting is
// byte-for-byte equivalent.
const PROJECT_PREFIX_RE = new RegExp(`^[^:]+:(${[...VALID_NODE_PREFIXES].join('|')}):([^\\n]+)\\n?$`);

// node.type → canonical ID prefix
const TYPE_TO_PREFIX = new Map([
  ['file', 'file'],
  ['function', 'function'],
  ['func', 'function'],
  ['class', 'class'],
  ['module', 'module'],
  ['concept', 'concept'],
  ['config', 'config'],
  ['document', 'document'],
  ['service', 'service'],
  ['table', 'table'],
  ['endpoint', 'endpoint'],
  ['pipeline', 'pipeline'],
  ['schema', 'schema'],
  ['resource', 'resource'],
  ['domain', 'domain'],
  ['flow', 'flow'],
  ['step', 'step'],
  // Knowledge-base node types
  ['article', 'article'],
  ['entity', 'entity'],
  ['topic', 'topic'],
  ['claim', 'claim'],
  ['source', 'source'],
]);

const COMPLEXITY_MAP = new Map([
  ['low', 'simple'],
  ['easy', 'simple'],
  ['medium', 'moderate'],
  ['intermediate', 'moderate'],
  ['high', 'complex'],
  ['hard', 'complex'],
  ['difficult', 'complex'],
]);

const VALID_COMPLEXITY = new Set(['simple', 'moderate', 'complex']);

// ── tested_by linker configuration ────────────────────────────────────────

// JS/TS family: a `.test.ts` file may be testing a `.ts`, `.tsx`, `.js`, etc.
// We try each candidate extension in priority order.
const JS_TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'];
const JS_TS_TEST_EXTS = new Set(JS_TS_EXTS);

// Mirrored production roots — when a test sits under `tests/`, it might be
// mirroring `src/`, `app/`, `lib/`, or the project root.
const MIRROR_PRODUCTION_ROOTS = ['src', 'app', 'lib', ''];

// Per-extension test-name patterns: ext → [prefix_patterns, suffix_patterns].
// A basename qualifies as a test if its stem starts with any prefix or ends
// with any suffix listed for its extension. JS/TS family is handled separately
// because its `.test`/`.spec` infix sits on the *stem* of a double-extension
// basename (e.g. `foo.test.ts` has ext `.ts`, stem `foo.test`).
const TEST_NAME_PATTERNS = new Map([
  ['.go', [[], ['_test']]],
  ['.py', [['test_'], ['_test']]],
  ['.java', [[], ['Test', 'Tests', 'IT']]],
  ['.kt', [[], ['Test', 'Tests']]],
  ['.scala', [[], ['Spec', 'Suite', 'Test', 'Tests']]],
  ['.cs', [[], ['Test', 'Tests']]],
  ['.swift', [[], ['Tests', 'Test', 'Spec']]],
  ['.rs', [['test_'], ['_test']]],
  ['.rb', [['test_'], ['_test', '_spec']]],
  ['.php', [[], ['Test']]],
  ['.dart', [[], ['_test']]],
  ['.c', [['test_'], ['_test']]],
  ['.cpp', [['test_'], ['_test']]],
  ['.cc', [['test_'], ['_test']]],
]);

// These language configs treat every source file below `tests/` as part of a
// test target, even when the basename itself has no test marker.  JS/TS is
// intentionally absent: files such as `__tests__/helpers.ts` remain helpers.
const TEST_DIRECTORY_EXTENSIONS = new Set(['.swift', '.rs', '.php']);

const EXACT_TEST_STEMS = new Map([['.rb', new Set(['spec_helper'])]]);

// Mirrors packages/core/src/schema.ts so the dashboard validator has nothing
// left to auto-correct for the `direction` field on merged graphs.
const DIRECTION_ALIASES = new Map([['both', 'bidirectional'], ['mutual', 'bidirectional']]);
const VALID_DIRECTIONS = new Set(['forward', 'backward', 'bidirectional']);

/** Canonicalize an edge `direction` value to one of the schema enum members. */
function normalizeDirection(value) {
  let candidate = typeof value === 'string' ? value.toLowerCase() : '';
  candidate = DIRECTION_ALIASES.get(candidate) ?? candidate;
  return VALID_DIRECTIONS.has(candidate) ? candidate : 'forward';
}

const MAXSIZE = 2n ** 63n - 1n;

/**
 * Return the logical batch index and optional part number for a batch file.
 *
 * Incremental updates write the pruned baseline graph as `batch-existing.json`;
 * treat it as a real batch that sorts before freshly analyzed numeric batches.
 */
export function parseBatchFilename(name) {
  if (name === 'batch-existing.json') return [-1n, null];
  const match = /^batch-(\d+)(?:-part-(\d+))?\.json/.exec(name);
  if (match === null) return null;
  return [BigInt(match[1]), match[2] ? BigInt(match[2]) : null];
}

function batchSortKey(name) {
  const parsed = parseBatchFilename(name);
  if (parsed === null) return [MAXSIZE, MAXSIZE, name];
  return [parsed[0], parsed[1] ?? 0n, name];
}

// ── Batch loading ─────────────────────────────────────────────────────────

/** Load a batch JSON file, tolerating malformed files. */
function loadBatch(path) {
  let data;
  try {
    data = loadJson(path);
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
    err(`  Warning: skipping ${basename(path)}: ${e.message}`);
    return null;
  }
  if (!Array.isArray(get(data, 'nodes'))) {
    err(`  Warning: skipping ${basename(path)}: missing or invalid 'nodes' array`);
    return null;
  }
  if (!Array.isArray(get(data, 'edges'))) {
    err(`  Warning: skipping ${basename(path)}: missing or invalid 'edges' array`);
    return null;
  }
  return data;
}

// ── ID normalization ──────────────────────────────────────────────────────

const hasValidPrefix = (id) => [...VALID_NODE_PREFIXES].some((p) => id.startsWith(`${p}:`));

/** Return a human-readable pattern label for an ID correction. */
function classifyIdFix(original, corrected) {
  // Double prefix: "file:file:..." → "file:..."
  for (const prefix of VALID_NODE_PREFIXES) {
    if (original.startsWith(`${prefix}:${prefix}:`)) return `${prefix}:${prefix}: → ${prefix}: (double prefix)`;
  }

  // Project-name prefix: "my-project:file:..." → "file:..."
  const parts = original.split(':');
  if (parts.length >= 3 && !VALID_NODE_PREFIXES.has(parts[0]) && VALID_NODE_PREFIXES.has(parts[1])) {
    return `<project>:${parts[1]}: → ${parts[1]}: (project-name prefix)`;
  }

  // Legacy func: → function:
  if (original.startsWith('func:') && corrected.startsWith('function:')) return 'func: → function: (prefix canonicalization)';

  // Bare path → prefixed
  if (!hasValidPrefix(original)) return `bare path → ${corrected.split(':')[0]}: (missing prefix)`;

  return `${original} → ${corrected}`;
}

/** Normalize a node ID, returning the corrected version. */
function normalizeNodeId(nodeId, node) {
  if (typeof nodeId !== 'string') throw new TypeError(`'${pyType(nodeId)}' object has no attribute 'startswith'`);
  let nid = nodeId;

  // Strip double prefix: "file:file:src/foo.ts" → "file:src/foo.ts"
  for (const prefix of VALID_NODE_PREFIXES) {
    if (nid.startsWith(`${prefix}:${prefix}:`)) {
      nid = nid.slice(prefix.length + 1);
      break;
    }
  }

  // Strip project-name prefix: "my-project:file:src/foo.ts" → "file:src/foo.ts"
  // Pattern: <word>:<valid-prefix>:<path>
  const match = PROJECT_PREFIX_RE.exec(nid);
  // Only strip if the first segment is NOT a valid prefix itself
  if (match && !VALID_NODE_PREFIXES.has(nid.split(':')[0])) nid = `${match[1]}:${match[2]}`;

  // Canonicalize legacy prefix: func: → function:
  if (nid.startsWith('func:') && !nid.startsWith('function:')) nid = `function:${nid.slice(5)}`;

  // Add missing prefix for bare file paths
  if (!hasValidPrefix(nid)) {
    const nodeType = get(node, 'type', 'file');
    const prefix = dictGet(TYPE_TO_PREFIX, nodeType, 'file');
    if (nodeType === 'function' || nodeType === 'class') {
      const filePath = get(node, 'filePath', '');
      const name = get(node, 'name', nid);
      // Without filePath, function:<name> collides with every other
      // function of the same name across the project. Prefix with a
      // placeholder so the collision is at least detectable in the
      // report instead of silently merging unrelated nodes.
      nid = truthy(filePath) ? `${prefix}:${pyStr(filePath)}:${pyStr(name)}` : `${prefix}:__nofilepath__:${pyStr(name)}`;
    } else {
      nid = `${prefix}:${nid}`;
    }
  }

  return nid;
}

/**
 * Normalize a complexity value. Returns [normalized, status].
 *
 * status is one of:
 *   "valid"    — already a valid value, no change needed
 *   "mapped"   — known alias, confidently mapped (goes to Fixed report)
 *   "unknown"  — unrecognized value, defaulted to moderate (goes to Could-not-fix report)
 */
function normalizeComplexity(value) {
  if (typeof value === 'string') {
    const lower = pyStrip(value).toLowerCase();
    if (VALID_COMPLEXITY.has(lower)) return [lower, 'valid'];
    if (COMPLEXITY_MAP.has(lower)) return [COMPLEXITY_MAP.get(lower), 'mapped'];
    // Unknown string — default but flag it
    return ['moderate', 'unknown'];
  }
  if (isNum(value)) {
    const x = typeof value === 'bigint' ? value : Number(value);
    if (typeof x === 'number' && !Number.isFinite(x)) throw new RangeError(`cannot convert float ${floatRepr(x).replace('-', '')} to integer`);
    const n = typeof x === 'bigint' ? x : Math.trunc(x);
    if (n <= 3) return ['simple', 'mapped'];
    if (n <= 6) return ['moderate', 'mapped'];
    return ['complex', 'mapped'];
  }
  // None or other type — default but flag it
  return ['moderate', 'unknown'];
}

// ── Deterministic tested_by linker ────────────────────────────────────────
//
// Two-pass linker. Both passes produce canonical `production → test` edges.
//
// Pass 1 — preserve LLM semantics, fix direction.
//   The LLM sees the relationship only when analyzing a *test* file
//   (production files don't import their tests), so its emitted direction
//   is systematically wrong: source = the file it was analyzing = a test.
//   We do NOT strip these edges — the *pairing* is real evidence (the LLM
//   saw an import / using / same-package call). We just flip direction
//   when source is test + target is production. Edges that are
//   semantically broken (test↔test, production↔production, orphan endpoints)
//   are dropped.
//
// Pass 2 — supplement with path-convention pairings.
//   For test files the LLM didn't link to anything, fall back to filename
//   conventions (sibling `_test.go`, JS/TS `__tests__/`, Maven `src/test/`,
//   etc.) to find a production counterpart. Pairs already covered by
//   Pass 1 are skipped.
//
// Why this beats strip-and-rederive: real projects often violate the
// linker's naming conventions (one Go `_test.go` covering several `.go`
// files in the same package, .NET `<svc>/tests/X.cs` against
// `<svc>/src/Y/X.cs`). Stripping LLM edges drops that real-world coverage
// signal entirely. Swapping preserves it.

/** Split a relative POSIX-style path into segments (ignoring empties). */
const pathSegments = (path) => path.split('/').filter(Boolean);

const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);

function splitext(p) {
  const sep = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  if (dot > sep) {
    for (let i = sep + 1; i < dot; i++) if (p[i] !== '.') return [p.slice(0, dot), p.slice(dot)];
  }
  return [p, ''];
}

/**
 * Return true if `path` looks like a test file by language convention.
 *
 * Most languages use basename markers. Swift, Rust, and PHP additionally
 * make `tests/` a test-source root. JS/TS files still require `.test` or
 * `.spec`, so `__tests__/helpers.ts` remains a non-test helper.
 */
function isTestPath(path) {
  const [stem, rawExt] = splitext(baseName(path));
  const ext = rawExt.toLowerCase();

  // JS/TS family: the test marker is an infix on the stem (foo.test.ts has
  // stem "foo.test", ext ".ts"), not a prefix/suffix on the stem itself.
  if (JS_TS_TEST_EXTS.has(ext)) return stem.endsWith('.test') || stem.endsWith('.spec');

  if (TEST_DIRECTORY_EXTENSIONS.has(ext) && pathSegments(path).slice(0, -1).some((segment) => segment.toLowerCase() === 'tests')) return true;

  const exactStems = EXACT_TEST_STEMS.get(ext);
  if (exactStems !== undefined && exactStems.has(stem)) return true;

  const patterns = TEST_NAME_PATTERNS.get(ext);
  if (patterns === undefined) return false;
  const [prefixes, suffixes] = patterns;
  return prefixes.some((p) => stem.startsWith(p)) || suffixes.some((s) => stem.endsWith(s));
}

/**
 * For a JS/TS-family stem like `foo.test` or `foo.spec`, strip the
 * trailing `.test` / `.spec`. Returns null if no infix is present.
 */
function stripTestInfix(stem) {
  for (const infix of ['.test', '.spec']) {
    if (stem.endsWith(infix)) return stem.slice(0, -infix.length);
  }
  return null;
}

/**
 * Join a (possibly empty) directory path to a basename with a single
 * slash, dropping the slash entirely when there is no directory.
 */
const joinPath = (dirPath, name) => (dirPath ? `${dirPath}/${name}` : name);

/** Append `path` to `out` unless it is empty or already present. */
function addUnique(out, path) {
  if (path && !out.includes(path)) out.push(path);
}

/**
 * Build sibling candidates for a JS/TS family base stem.
 *
 * `dirPath` is the parent dir (no trailing slash, may be empty).
 * `baseStem` is the stem with the test infix already stripped.
 */
const jsTsSiblingCandidates = (dirPath, baseStem) => JS_TS_EXTS.map((e) => joinPath(dirPath, `${baseStem}${e}`));

/**
 * For a test file path, return ordered candidate production paths.
 *
 * The returned list is in priority order (sibling first, then `__tests__`
 * walk-out, then mirrored-tree variants). Duplicates are removed while
 * preserving order. Caller should pick the first candidate that resolves
 * to a known production node.
 */
function productionCandidates(testPath) {
  const [stem, ext] = splitext(baseName(testPath));
  const segs = pathSegments(testPath);
  const dirSegs = segs.slice(0, -1);
  const dirPath = dirSegs.join('/');

  const candidates = [];

  // ── JS/TS family ──────────────────────────────────────────────────
  if (JS_TS_TEST_EXTS.has(ext)) {
    const baseStem = stripTestInfix(stem);
    if (baseStem !== null) {
      // 1. Sibling de-infix: prefer the same extension as the test, then
      // the rest of the family.
      addUnique(candidates, joinPath(dirPath, `${baseStem}${ext}`));
      for (const c of jsTsSiblingCandidates(dirPath, baseStem)) addUnique(candidates, c);

      // 2. Walk out of test-segregating subdir — drop the trailing
      // __tests__/test/spec/tests segment. Some JS/TS projects use
      // `<dir>/test/foo.spec.ts` or `<dir>/spec/foo.spec.ts` instead of
      // the more idiomatic `__tests__/`; treat them the same.
      if (dirSegs.length && ['__tests__', 'test', 'spec', 'tests'].includes(dirSegs.at(-1))) {
        const parentDir = dirSegs.slice(0, -1).join('/');
        addUnique(candidates, joinPath(parentDir, `${baseStem}${ext}`));
        for (const c of jsTsSiblingCandidates(parentDir, baseStem)) addUnique(candidates, c);
      }

      // 3. Mirrored tree: tests/foo/X.test.ts → src/foo/X.ts (and
      // variants for app/lib/<root>).
      if (dirSegs.length && ['tests', 'test', '__tests__'].includes(dirSegs[0])) {
        const tailPath = dirSegs.slice(1).join('/');
        for (const root of MIRROR_PRODUCTION_ROOTS) {
          const newDir = [root, tailPath].filter(Boolean).join('/');
          addUnique(candidates, joinPath(newDir, `${baseStem}${ext}`));
          for (const c of jsTsSiblingCandidates(newDir, baseStem)) addUnique(candidates, c);
        }
      }
    }
  }

  // ── Go ────────────────────────────────────────────────────────────
  else if (ext === '.go' && stem.endsWith('_test')) {
    addUnique(candidates, joinPath(dirPath, `${stem.slice(0, -'_test'.length)}.go`));
  }

  // ── Python ────────────────────────────────────────────────────────
  else if (ext === '.py' && (stem.startsWith('test_') || stem.endsWith('_test'))) {
    const baseStem = stem.startsWith('test_') ? stem.slice('test_'.length) : stem.slice(0, -'_test'.length);

    // Sibling
    addUnique(candidates, joinPath(dirPath, `${baseStem}.py`));

    // Walk out of an in-package tests/ or test/ directory:
    // `mypkg/tests/test_bar.py` → `mypkg/bar.py`. Common in Django apps
    // and any project that colocates tests with the package they cover.
    if (dirSegs.length && ['tests', 'test'].includes(dirSegs.at(-1))) {
      addUnique(candidates, joinPath(dirSegs.slice(0, -1).join('/'), `${baseStem}.py`));
    }

    // Mirrored: tests/foo/test_bar.py → src/foo/bar.py (and variants)
    if (dirSegs.length && ['tests', 'test'].includes(dirSegs[0])) {
      const tailPath = dirSegs.slice(1).join('/');
      for (const root of MIRROR_PRODUCTION_ROOTS) {
        addUnique(candidates, joinPath([root, tailPath].filter(Boolean).join('/'), `${baseStem}.py`));
      }
    }
  }

  // ── Java ──────────────────────────────────────────────────────────
  else if (ext === '.java') {
    for (const suffix of ['Tests', 'Test', 'IT']) {
      if (stem.endsWith(suffix)) {
        const baseStem = stem.slice(0, -suffix.length);
        // Maven/Gradle layout: swap src/test/java/... → src/main/java/...
        if (dirSegs.length >= 3 && dirSegs[0] === 'src' && dirSegs[1] === 'test' && dirSegs[2] === 'java') {
          addUnique(candidates, `${['src', 'main', 'java', ...dirSegs.slice(3)].join('/')}/${baseStem}.java`);
        }
        // Sibling fallback
        addUnique(candidates, joinPath(dirPath, `${baseStem}.java`));
        break;
      }
    }
  }

  // ── Kotlin ────────────────────────────────────────────────────────
  else if (ext === '.kt') {
    for (const suffix of ['Tests', 'Test']) {
      if (stem.endsWith(suffix)) {
        const baseStem = stem.slice(0, -suffix.length);
        if (dirSegs.length >= 3 && dirSegs[0] === 'src' && dirSegs[1] === 'test' && dirSegs[2] === 'kotlin') {
          addUnique(candidates, `${['src', 'main', 'kotlin', ...dirSegs.slice(3)].join('/')}/${baseStem}.kt`);
        }
        addUnique(candidates, joinPath(dirPath, `${baseStem}.kt`));
        break;
      }
    }
  }

  // ── Scala ─────────────────────────────────────────────────────────
  else if (ext === '.scala') {
    for (const suffix of ['Spec', 'Suite', 'Tests', 'Test']) {
      if (stem.endsWith(suffix)) {
        const baseStem = stem.slice(0, -suffix.length);
        // sbt layout: swap any .../src/test/scala/... segment while
        // preserving a module prefix such as modules/core/.
        for (let i = 0; i < Math.max(dirSegs.length - 2, 0); i++) {
          if (dirSegs[i] === 'src' && dirSegs[i + 1] === 'test' && dirSegs[i + 2] === 'scala') {
            addUnique(candidates, `${[...dirSegs.slice(0, i), 'src', 'main', 'scala', ...dirSegs.slice(i + 3)].join('/')}/${baseStem}.scala`);
            break;
          }
        }
        addUnique(candidates, joinPath(dirPath, `${baseStem}.scala`));
        break;
      }
    }
  }

  // ── C# ────────────────────────────────────────────────────────────
  else if (ext === '.cs') {
    for (const suffix of ['Tests', 'Test']) {
      if (stem.endsWith(suffix)) {
        const baseStem = stem.slice(0, -suffix.length);
        // Sibling fallback (e.g. `Foo.Tests/BarTests.cs` ↔ same dir
        // is rare but cheap to try).
        addUnique(candidates, joinPath(dirPath, `${baseStem}.cs`));

        // Walk out of an in-service `tests/` directory and search
        // the sibling `src/` subtree. Handles layouts like
        // `src/<svc>/tests/BarTests.cs` ↔ `src/<svc>/src/.../Bar.cs`
        // (microservices-demo cartservice) and bare
        // `<proj>/tests/BarTests.cs` ↔ `<proj>/src/Bar.cs`.
        let testsIdx = null;
        for (let i = dirSegs.length - 1; i >= 0; i--) {
          if (['tests', 'test'].includes(dirSegs[i].toLowerCase())) {
            testsIdx = i;
            break;
          }
        }
        if (testsIdx !== null) {
          const parentSegs = dirSegs.slice(0, testsIdx);
          const tailSegs = dirSegs.slice(testsIdx + 1);
          // `<parent>/<base_stem>.cs` (drop `tests/` entirely).
          addUnique(candidates, joinPath(parentSegs.join('/'), `${baseStem}.cs`));
          // `<parent>/src/<tail>/<base_stem>.cs` (mirror through src/).
          addUnique(candidates, joinPath([...parentSegs, 'src', ...tailSegs].join('/'), `${baseStem}.cs`));
        }

        // `.NET`-style sibling-project mirror: `My.App.Tests/...` ↔
        // `My.App/...`. The test project's top dir typically ends in
        // `.Tests`. Strip it and try the same tail under the sibling.
        if (dirSegs.length) {
          const top = dirSegs[0];
          if (top.endsWith('.Tests') || top.endsWith('.Test')) {
            const sibling = top.endsWith('.Tests') ? top.slice(0, -'.Tests'.length) : top.slice(0, -'.Test'.length);
            if (sibling) addUnique(candidates, joinPath([sibling, ...dirSegs.slice(1)].join('/'), `${baseStem}.cs`));
          }
        }
        break;
      }
    }
  }

  // ── C/C++ ─────────────────────────────────────────────────────────
  else if (['.c', '.cpp', '.cc'].includes(ext)) {
    const baseStem = stem.startsWith('test_') ? stem.slice('test_'.length) : stem.endsWith('_test') ? stem.slice(0, -'_test'.length) : null;
    if (baseStem !== null) addUnique(candidates, joinPath(dirPath, `${baseStem}${ext}`));
  }

  return candidates;
}

/** Return the relative project path for a `file:`-prefixed node, else null. */
function fileNodePath(node) {
  const nid = get(node, 'id', '');
  if (typeof nid !== 'string' || !nid.startsWith('file:')) return null;
  const fp = get(node, 'filePath');
  if (typeof fp === 'string' && fp) return fp;
  return nid.slice('file:'.length);
}

/**
 * Flip an inverted `tested_by` edge so source becomes production and
 * target becomes the test file. Mutates `edge` in place; appends a
 * `[direction corrected]` audit marker to `description`.
 */
function swapTestedByInPlace(edge, originalSrc, originalTgt) {
  edge.source = originalTgt;
  edge.target = originalSrc;
  edge.direction = 'forward';
  const prev = get(edge, 'description');
  edge.description = !truthy(prev) ? 'Direction corrected (was test → production)' : `${pyStr(prev)} [direction corrected]`;
}

/**
 * Append "tested" to `node.tags`, coercing malformed `tags` to a
 * fresh list. Returns true if the tag was newly added.
 *
 * `tags` from raw LLM batch JSON may be missing, null, a string, or
 * another non-list value — the TypeScript autoFixGraph normalizer that
 * handles this runs downstream of this script, so we defend here.
 */
function ensureTestedTag(node) {
  let tags = get(node, 'tags');
  if (!Array.isArray(tags)) {
    tags = [];
    node.tags = tags;
  }
  if (tags.includes('tested')) return false;
  tags.push('tested');
  return true;
}

/**
 * Canonicalize `tested_by` edges and link unmatched test files.
 *
 * Two passes (see module-level "Deterministic tested_by linker" comment
 * for the rationale):
 *
 *   1. Walk every existing `tested_by` edge. Keep canonical
 *      (production → test) edges as-is. Flip inverted (test → production)
 *      edges so the swap preserves the LLM's pairing evidence with the
 *      right direction. Drop edges that don't classify cleanly as
 *      file ↔ file or where one endpoint is missing — they have no
 *      recoverable meaning.
 *   2. For every test file not yet paired by Pass 1, walk path-convention
 *      candidates and emit a fresh `production → test` edge for the first
 *      match.
 *
 * Tagging happens once per production node that ends up on the source
 * side of any `tested_by` edge (canonical, swapped, or supplemented).
 *
 * Mutates `nodesById` (adds "tested" tag) and `edges` (rewrites
 * in place: drops semantically broken edges, swaps inverted ones, appends
 * supplements).
 *
 * Returns [added, dropped, tagged, swapped]:
 *   added:   path-convention supplemental edges appended in Pass 2
 *   dropped: pre-existing `tested_by` edges removed (unsalvageable)
 *   tagged:  production nodes newly tagged "tested"
 *   swapped: pre-existing `tested_by` edges flipped (test → production
 *            became production → test)
 */
function linkTests(nodesById, edges) {
  // ── Index file nodes by relative path; classify each as test/production.
  // `isProd` here means "is a known file node AND is not a test by
  // path convention" — used both to validate edge endpoints and to drive
  // path-convention candidate matching.
  const filePathsToNodes = new Map();
  const nodeIdToClassification = new Map(); // id → "test" | "prod"
  const testNodes = [];
  for (const node of nodesById.values()) {
    const path = fileNodePath(node);
    if (path === null) continue;
    filePathsToNodes.set(path, node);
    if (isTestPath(path)) {
      nodeIdToClassification.set(node.id, 'test');
      testNodes.push([path, node]);
    } else {
      nodeIdToClassification.set(node.id, 'prod');
    }
  }

  // ── Pass 1: walk existing tested_by edges, canonicalize or drop.
  // `covered` tracks (production_id, test_id) pairs that have a kept edge
  // after this pass — used both to deduplicate within Pass 1 and to
  // suppress duplicate supplements in Pass 2.
  // `pairToIdx` maps each kept pair to its slot in the compacted edges
  // list, so a duplicate that arrives later with a higher weight can
  // replace the earlier slot in place (mirrors Step 6's
  // `weight > existing.weight` rule — without this, a 0.3-weight edge
  // from batch 1 would silently outrank a 0.9-weight edge from batch 2
  // because Step 6 only ever sees one of them).
  // `swappedPairs` records which surviving pairs came from a flipped
  // edge, so the `swapped` counter reflects the FINAL output and
  // doesn't double-count work done on edges that were later replaced.
  const covered = new Map();
  const pairToIdx = new Map();
  const swappedPairs = new Set();
  let dropped = 0;
  let writeIdx = 0;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (get(edge, 'type') !== 'tested_by') {
      edges[writeIdx++] = edge;
      continue;
    }

    const src = get(edge, 'source', '');
    const tgt = get(edge, 'target', '');
    const srcClass = typeof src === 'string' ? nodeIdToClassification.get(src) : undefined;
    const tgtClass = typeof tgt === 'string' ? nodeIdToClassification.get(tgt) : undefined;

    // Both endpoints must be known file nodes; one test, one production.
    // Anything else (orphan, test↔test, prod↔prod, non-file endpoint)
    // has no recoverable meaning — drop it.
    let pair;
    let needsSwap;
    if (srcClass === 'prod' && tgtClass === 'test') {
      pair = [src, tgt];
      needsSwap = false;
    } else if (srcClass === 'test' && tgtClass === 'prod') {
      pair = [tgt, src];
      needsSwap = true;
    } else {
      dropped += 1;
      continue;
    }
    const pairKey = JSON.stringify(pair);

    if (covered.has(pairKey)) {
      // Duplicate pair: keep the heavier-weight edge (mirrors the
      // weight-aware dedup in Step 6, which can't help here because
      // only one of the duplicates would reach it).
      const existingIdx = pairToIdx.get(pairKey);
      if (num(get(edge, 'weight', 0)) > num(get(edges[existingIdx], 'weight', 0))) {
        // Heavier — replace existing slot. Apply the swap (or not)
        // only on the survivor, so we never spend cycles canonicalizing
        // an edge we're about to drop.
        if (needsSwap) {
          swapTestedByInPlace(edge, src, tgt);
          swappedPairs.add(pairKey);
        } else {
          // Replacement is canonical — if the previous winner came
          // from a swap, the surviving slot is no longer a swap.
          swappedPairs.delete(pairKey);
        }
        edges[existingIdx] = edge;
      }
      // else: existing is heavier or equal — keep it, drop the new edge.
      dropped += 1;
      continue;
    }

    if (needsSwap) {
      swapTestedByInPlace(edge, src, tgt);
      swappedPairs.add(pairKey);
    }
    covered.set(pairKey, pair);
    pairToIdx.set(pairKey, writeIdx);
    edges[writeIdx++] = edge;
  }
  edges.length = writeIdx;
  const swapped = swappedPairs.size;

  // ── Pass 2: path-convention supplement for tests not yet paired.
  const pairedTestIds = new Set([...covered.values()].map(([, testId]) => testId));
  let added = 0;
  for (const [testPath, testNode] of testNodes) {
    if (pairedTestIds.has(testNode.id)) continue;
    for (const candPath of productionCandidates(testPath)) {
      const prodNode = filePathsToNodes.get(candPath);
      if (prodNode === undefined) continue;
      // Don't link a test to another test even if naming aligns.
      if (isTestPath(candPath)) continue;
      const pair = [prodNode.id, testNode.id];
      const pairKey = JSON.stringify(pair);
      if (covered.has(pairKey)) continue;
      edges.push({
        source: prodNode.id,
        target: testNode.id,
        type: 'tested_by',
        direction: 'forward',
        weight: 0.5,
        description: 'Path-based pairing (deterministic)',
      });
      covered.set(pairKey, pair);
      added += 1;
      break;
    }
  }

  // ── Tag every production node that ended up sourcing a tested_by edge
  // (covers Pass 1 canonical + swapped + Pass 2 supplements in one place).
  let tagged = 0;
  for (const [prodId] of covered.values()) {
    const prodNode = nodesById.get(prodId);
    if (prodNode === undefined) continue;
    if (ensureTestedTag(prodNode)) tagged += 1;
  }

  return [added, dropped, tagged, swapped];
}

// ── Main merge + normalize ────────────────────────────────────────────────

/** Merge batch results and normalize. Returns [assembledGraph, reportLines]. */
function mergeAndNormalize(batches, currentEdgeIds = null, danglingCandidates = null) {
  // ── Pattern counters for "Fixed" report ──────────────────────────
  const idFixPatterns = new Counter();
  const complexityFixPatterns = new Counter();

  // ── Detail lists for "Could not fix" report ──────────────────────
  const unfixable = [];

  // ── Step 1: Combine all nodes and edges ──────────────────────────
  const allNodes = [];
  const allEdges = [];
  for (const batch of batches) {
    for (const node of get(batch, 'nodes', [])) allNodes.push(node);
    for (const edge of get(batch, 'edges', [])) allEdges.push(edge);
  }

  const totalInputNodes = allNodes.length;
  const totalInputEdges = allEdges.length;

  // ── Step 2: Normalize node IDs and build ID mapping ──────────────
  const idMapping = new Map(); // original → corrected
  const nodesWithIds = [];
  const unknownNodeTypes = new Counter();

  allNodes.forEach((node, i) => {
    const originalId = get(node, 'id');
    if (!truthy(originalId)) {
      unfixable.push(`Node[${i}] has no 'id' field (name=${pyStr(get(node, 'name', '?'))}, type=${pyStr(get(node, 'type', '?'))})`);
      return;
    }

    // Flag unknown node types
    const nodeType = get(node, 'type', '');
    if (truthy(nodeType) && !has(TYPE_TO_PREFIX, nodeType)) unknownNodeTypes.add(nodeType);

    nodesWithIds.push(node);
    const correctedId = normalizeNodeId(originalId, node);
    if (correctedId !== originalId) {
      idFixPatterns.add(classifyIdFix(originalId, correctedId));
      idMapping.set(originalId, correctedId);
      node.id = correctedId;
    }
  });

  // ── Step 3: Normalize complexity ─────────────────────────────────
  const complexityUnknownPatterns = new Counter();

  for (const node of nodesWithIds) {
    const original = get(node, 'complexity');
    const [normalized, status] = normalizeComplexity(original);
    const origRepr = typeof original === 'string' ? `"${original}"` : pyRepr(original);

    if (status === 'mapped') complexityFixPatterns.add(`${origRepr} → "${normalized}"`);
    else if (status === 'unknown') complexityUnknownPatterns.add(`complexity ${origRepr} → defaulted to "moderate"`);

    node.complexity = normalized;
  }

  // ── Step 4: Rewrite edge references ──────────────────────────────
  let edgesRewritten = 0;
  for (const edge of allEdges) {
    const src = get(edge, 'source', '');
    const tgt = get(edge, 'target', '');
    const newSrc = dictGet(idMapping, src, src);
    const newTgt = dictGet(idMapping, tgt, tgt);
    if (newSrc !== src || newTgt !== tgt) {
      edgesRewritten += 1;
      edge.source = newSrc;
      edge.target = newTgt;
    }
  }

  // ── Step 5: Deduplicate nodes by ID (keep last) ─────────────────
  let duplicateCount = 0;
  const nodesById = new Map();
  for (const node of nodesWithIds) {
    const nid = get(node, 'id', '');
    if (nodesById.has(nid)) duplicateCount += 1;
    nodesById.set(nid, node);
  }

  // ── Step 5b: Deterministic tested_by linker ──────────────────────
  // See module-level "Deterministic tested_by linker" section above.
  const [testedByAdded, testedByDropped, testedByTagged, testedBySwapped] = linkTests(nodesById, allEdges);

  // ── Step 6: Deduplicate edges, drop dangling ─────────────────────
  // Direction is part of the dedup key so a `forward` edge does not silently
  // overwrite a `bidirectional` one (or vice versa); they're different
  // semantic relationships that the dashboard renders distinctly.
  const edgesByKey = new Map();
  const danglingByKey = new Map();
  for (const edge of allEdges) {
    const src = get(edge, 'source', '');
    const tgt = get(edge, 'target', '');
    const etype = get(edge, 'type', '');
    const direction = normalizeDirection(get(edge, 'direction'));
    edge.direction = direction;
    const key = () => JSON.stringify([pyKey(src), pyKey(tgt), pyKey(etype), direction]);
    const srcKnown = typeof src === 'string' && nodesById.has(src);
    const tgtKnown = typeof tgt === 'string' && nodesById.has(tgt);

    if (!srcKnown || !tgtKnown) {
      // Preserve normalized CURRENT analyzer evidence before unresolved
      // endpoints are discarded. Never collect edges from batch-existing.
      if (danglingCandidates !== null && currentEdgeIds !== null && currentEdgeIds.has(edge)) {
        const k = key();
        const previous = danglingByKey.get(k);
        if (previous === undefined || num(get(edge, 'weight', 0)) > num(get(previous, 'weight', 0))) danglingByKey.set(k, { ...edge });
      }
      const missing = [];
      if (!srcKnown) missing.push(`source '${pyStr(src)}'`);
      if (!tgtKnown) missing.push(`target '${pyStr(tgt)}'`);
      unfixable.push(`Edge ${pyStr(src)} → ${pyStr(tgt)} (${pyStr(etype)}): dropped, missing ${missing.join(', ')}`);
      continue;
    }

    const k = key();
    const existing = edgesByKey.get(k);
    if (existing === undefined || num(get(edge, 'weight', 0)) > num(get(existing, 'weight', 0))) edgesByKey.set(k, edge);
  }

  if (danglingCandidates !== null) for (const edge of danglingByKey.values()) danglingCandidates.push(edge);

  // ── Build report ─────────────────────────────────────────────────
  const report = [`Input: ${totalInputNodes} nodes, ${totalInputEdges} edges`];

  // Fixed section — grouped by pattern
  const fixedLines = [];
  for (const [pattern, count] of idFixPatterns.mostCommon()) fixedLines.push(`  ${pad(count)} × ${pattern}`);
  for (const [pattern, count] of complexityFixPatterns.mostCommon()) fixedLines.push(`  ${pad(count)} × complexity ${pattern}`);
  if (edgesRewritten) fixedLines.push(`  ${pad(edgesRewritten)} × edge references rewritten after ID normalization`);
  if (duplicateCount) fixedLines.push(`  ${pad(duplicateCount)} × duplicate node IDs removed (kept last)`);
  if (testedBySwapped) fixedLines.push(`  ${pad(testedBySwapped)} × tested_by edges flipped (test → production became production → test)`);
  if (testedByDropped) fixedLines.push(`  ${pad(testedByDropped)} × tested_by edges dropped (orphan endpoint or test↔test / prod↔prod pair)`);

  if (fixedLines.length) {
    const totalFixes = idFixPatterns.total() + complexityFixPatterns.total() + edgesRewritten + duplicateCount + testedBySwapped + testedByDropped;
    report.push('', `Fixed (${totalFixes} corrections):`, ...fixedLines);
  }

  // Tested-by linker section — separate from Fixed since these are net-new
  // additions, not corrections.
  if (testedByAdded || testedByTagged) {
    report.push(
      '',
      'Tested-by linker:',
      `  ${pad(testedByAdded)} × tested_by edges produced (path-convention supplement, production → test)`,
      `  ${pad(testedByTagged)} × production nodes tagged "tested"`,
    );
  }

  // Could not fix section — unknown patterns (grouped) + individual details
  const unfixableTotal = unfixable.length + complexityUnknownPatterns.total() + unknownNodeTypes.total();
  if (unfixableTotal) {
    report.push('', `Could not fix (${unfixableTotal} issues — needs agent review):`);
    // Unknown node types (grouped by count)
    for (const [ntype, count] of unknownNodeTypes.mostCommon()) report.push(`  ${pad(count)} × unknown node type "${pyStr(ntype)}" (not in schema, kept as-is)`);
    // Unknown complexity patterns (grouped by count)
    for (const [pattern, count] of complexityUnknownPatterns.mostCommon()) report.push(`  ${pad(count)} × ${pattern}`);
    // Individual unfixable items
    for (const detail of unfixable) report.push(`  - ${detail}`);
  }

  // Output stats
  report.push('', `Output: ${nodesById.size} nodes, ${edgesByKey.size} edges`);

  return [{ nodes: [...nodesById.values()], edges: [...edgesByKey.values()] }, report];
}

// ── Imports-edge recovery from importMap ──────────────────────────────────

const WHOLE_FILE_NODE_TYPES = new Set(['file', 'config', 'document', 'service', 'pipeline', 'schema', 'resource']);

/**
 * Map each filePath to its canonical whole-file node id.
 *
 * Only exact `<type>:<filePath>` IDs qualify. This intentionally excludes
 * child constructs such as tables and endpoints, even when they carry the
 * same `filePath`. If an analyzer emitted more than one whole-file node for
 * a path, `file:` wins; otherwise the first stable graph occurrence wins.
 */
function buildWholeFileNodeIndex(nodes) {
  const index = new Map();
  const selectedTypes = new Map();
  const warnings = [];

  for (const node of nodes) {
    const nodeType = get(node, 'type');
    const filePath = get(node, 'filePath');
    const nodeId = get(node, 'id');
    if (!has(WHOLE_FILE_NODE_TYPES, nodeType) || typeof filePath !== 'string' || !filePath || nodeId !== `${nodeType}:${filePath}`) continue;

    const existingId = index.get(filePath);
    if (existingId === undefined) {
      index.set(filePath, nodeId);
      selectedTypes.set(filePath, nodeType);
      continue;
    }

    let selected = existingId;
    if (nodeType === 'file' && selectedTypes.get(filePath) !== 'file') {
      index.set(filePath, nodeId);
      selectedTypes.set(filePath, nodeType);
      selected = nodeId;
    }
    warnings.push(`  Warning: multiple whole-file nodes for ${filePath}; selected ${selected}`);
  }

  return [index, warnings];
}

/**
 * Re-emit any `imports` edges that exist in `scan-result.json#importMap`
 * but never made it into a batch's output. The project-scanner's importMap
 * is the deterministic source of truth for resolved internal imports;
 * file-analyzer agents are expected to transcribe those into edges 1:1
 * but in practice drop ~25% of them on real projects (orchestrator-side
 * batch construction loses entries, agent-side enumeration drops more).
 *
 * Returns [recoveredCount, reportLines].
 */
function recoverImportsFromScan(assembled, scanResultPath) {
  const name = basename(scanResultPath);
  if (!isFile(scanResultPath)) return [0, [`  importMap recovery skipped — ${name} not found`]];

  let scan;
  try {
    scan = loadJson(scanResultPath);
  } catch (e) {
    if (!(e instanceof PyError)) throw e;
    return [0, [`  importMap recovery skipped — could not parse ${name}: ${e.message}`]];
  }

  const importMap = get(scan, 'importMap');
  if (!isDict(importMap)) return [0, [`  importMap recovery skipped — no importMap field in ${name}`]];

  const [filePathToNodeId, conflictWarnings] = buildWholeFileNodeIndex(assembled.nodes);

  // Build the set of (source, target) imports edges already present.
  const existing = new Set();
  for (const edge of assembled.edges) {
    if (get(edge, 'type') === 'imports') existing.add(JSON.stringify([get(edge, 'source', ''), get(edge, 'target', '')]));
  }

  let recovered = 0;
  let skippedNoSrcNode = 0;
  let skippedNoTgtNode = 0;
  for (const [srcPath, targets] of Object.entries(importMap)) {
    if (!Array.isArray(targets)) continue;
    const srcId = filePathToNodeId.get(srcPath);
    if (srcId === undefined) {
      if (targets.length) skippedNoSrcNode += 1;
      continue;
    }
    for (const tgtPath of targets) {
      if (typeof tgtPath !== 'string' || !tgtPath) continue;
      const tgtId = filePathToNodeId.get(tgtPath);
      if (tgtId === undefined) {
        skippedNoTgtNode += 1;
        continue;
      }
      if (srcId === tgtId) continue;
      const pairKey = JSON.stringify([srcId, tgtId]);
      if (existing.has(pairKey)) continue;
      assembled.edges.push({
        source: srcId,
        target: tgtId,
        type: 'imports',
        direction: 'forward',
        weight: 0.7,
        recoveredFromImportMap: true,
      });
      existing.add(pairKey);
      recovered += 1;
    }
  }

  const lines = [...conflictWarnings, `  Recovered ${recovered} \`imports\` edges from importMap (${Object.keys(importMap).length} entries scanned)`];
  if (skippedNoSrcNode) lines.push(`  Skipped ${skippedNoSrcNode} importMap source files with no whole-file node in graph`);
  if (skippedNoTgtNode) lines.push(`  Skipped ${skippedNoTgtNode} importMap target paths with no whole-file node in graph`);
  return [recovered, lines];
}

// ── Main ──────────────────────────────────────────────────────────────────

const isIncrementalAction = (plan) => ['PARTIAL_UPDATE', 'ARCHITECTURE_UPDATE'].includes(get(plan, 'action'));

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    err('Usage: node merge-batch-graphs.mjs <project-root>');
    process.exit(1);
  }

  const projectRoot = pyResolve(argv[0]);
  const intermediateDir = join(resolveUaDir(projectRoot), 'intermediate');
  const planPath = join(intermediateDir, 'incremental-plan.json');
  const plan = existsSync(planPath) ? loadJson(planPath) : {};
  const incremental = isIncrementalAction(plan);

  if (!isDir(intermediateDir)) {
    err(`Error: ${intermediateDir} does not exist`);
    process.exit(1);
  }

  // Discover batch files, sorted by numeric index (not lexicographic).
  // `batch-existing.json` is the documented incremental baseline and must
  // sort before fresh batches so fresh duplicate nodes/edges win later.
  const batchFiles = readdirSync(intermediateDir)
    .filter((name) => /^batch-[\s\S]*\.json$/.test(name))
    .sort((a, b) => {
      const ka = batchSortKey(a);
      const kb2 = batchSortKey(b);
      for (let i = 0; i < 3; i++) if (ka[i] !== kb2[i]) return ka[i] < kb2[i] ? -1 : 1;
      return 0;
    });
  if (!batchFiles.length) {
    err('Error: no batch-*.json files found in intermediate/');
    process.exit(1);
  }

  // Group by logical batch index so the report distinguishes single-batch
  // files from multi-part file-analyzer outputs. Files that don't match the
  // `batch-existing.json` / `batch-<N>.json` / `batch-<N>-part-<K>.json`
  // pattern (e.g. fused `batch-fused-8-13.json`, range `batch-8-13.json`)
  // would otherwise be silently dropped during load — flag them loudly
  // instead so the user can fix the file-analyzer agent.
  const byBatch = new Map();
  const unrecognizedBatchFiles = [];
  for (const name of batchFiles) {
    const parsed = parseBatchFilename(name);
    if (parsed === null) {
      unrecognizedBatchFiles.push(name);
    } else {
      const idx = String(parsed[0]);
      if (!byBatch.has(idx)) byBatch.set(idx, []);
      byBatch.get(idx).push([name, parsed[1]]);
    }
  }

  const unrecognizedPreview = () => {
    const preview = unrecognizedBatchFiles.slice(0, 5).join(', ');
    const suffix = unrecognizedBatchFiles.length > 5 ? ` (+${unrecognizedBatchFiles.length - 5} more)` : '';
    return `${preview}${suffix}`;
  };

  if (unrecognizedBatchFiles.length) {
    err(
      `Warning: merge-batch-graphs: ${unrecognizedBatchFiles.length} batch file(s) with unrecognized filenames will be DROPPED — ` +
        `files: ${unrecognizedPreview()} — fix the file-analyzer agent to use only batch-<N>.json or batch-<N>-part-<K>.json patterns`,
    );
  }

  const logicalCount = byBatch.size;
  const multiPart = [...byBatch.values()].filter((entries) => entries.length > 1).length;
  err(`Found ${batchFiles.length} batch files (${logicalCount} logical batches, ${multiPart} multi-part):`);

  // Missing-part detection: for any logical batch with parts (len > 1), the
  // set of part numbers MUST be contiguous starting at 1. Gaps suggest a
  // truncated write — emit a visible warning so the user can investigate.
  // Collect into `missingPartWarnings` so they also surface in the final
  // phase report; stderr alone gets buried under the per-batch load lines.
  const missingPartWarnings = [];
  for (const [idx, entries] of byBatch) {
    const partNums = entries.map(([, p]) => p).filter((p) => p !== null);
    if (!partNums.length) continue;
    const present = [...new Set(partNums)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const presentKeys = new Set(present.map(String));
    const max = present.at(-1);
    const missing = [];
    for (let p = 1n; p <= max; p++) if (!presentKeys.has(String(p))) missing.push(p);
    if (missing.length) {
      const msg = `batch ${idx} has parts [${present.join(', ')}] but missing part [${missing.join(', ')}] — possible truncated write — affected nodes/edges may be lost`;
      err(`Warning: merge: ${msg}`);
      missingPartWarnings.push(msg);
    }
  }

  // Load batches — skip unrecognized filenames so they don't pollute the
  // merged graph with content the agent labeled incorrectly.
  const unrecognizedSet = new Set(unrecognizedBatchFiles);
  const batches = [];
  const currentEdgeIds = new Set();
  const emptyBatchWarnings = [];
  for (const name of batchFiles) {
    if (unrecognizedSet.has(name)) continue;
    const batch = loadBatch(join(intermediateDir, name));
    if (batch !== null) {
      batches.push(batch);
      if (incremental && name !== 'batch-existing.json') for (const edge of get(batch, 'edges', [])) currentEdgeIds.add(edge);
      const n = get(batch, 'nodes', []).length;
      const e = get(batch, 'edges', []).length;
      err(`  ${name}: ${n} nodes, ${e} edges`);
      // A file that parses but contributes nothing is how a silent
      // partial merge looks from the outside (see #484) — flag it
      // loudly instead of relying on a downstream reviewer to notice.
      if (n === 0 && e === 0) {
        const msg = `${name} loaded but contributed 0 nodes and 0 edges — either the analyzer wrote an empty batch or the file was read mid-write; inspect it directly`;
        err(`  Warning: ${msg}`);
        emptyBatchWarnings.push(msg);
      }
    }
  }

  if (!batches.length) {
    err('Error: no valid batch files loaded');
    process.exit(1);
  }

  // Merge and normalize
  const danglingCandidates = [];
  const [assembled, report] = mergeAndNormalize(batches, incremental ? currentEdgeIds : null, incremental ? danglingCandidates : null);

  // Surface missing multi-part files to the phase report (parallel to
  // unrecognized-filename handling below). Stderr lines emitted during
  // batch discovery get buried under per-batch load output — re-emitting
  // via the report list ensures the Phase 4 review and final summary see
  // the data-loss signal.
  if (missingPartWarnings.length) {
    report.push('', `Warning: ${missingPartWarnings.length} batch(es) with missing parts — some nodes/edges silently dropped:`);
    for (const w of missingPartWarnings) report.push(`  - ${w}`);
  }

  // Surface empty-contribution batches to the phase report (same rationale
  // as missingPartWarnings above — stderr alone gets buried).
  if (emptyBatchWarnings.length) {
    report.push('', `Warning: ${emptyBatchWarnings.length} batch file(s) loaded but contributed no nodes or edges:`);
    for (const w of emptyBatchWarnings) report.push(`  - ${w}`);
  }

  // Surface unrecognized-filename drops to the phase report so the
  // downstream review step sees them, not just stderr.
  if (unrecognizedBatchFiles.length) {
    report.push(
      '',
      `Warning: dropped ${unrecognizedBatchFiles.length} batch file(s) with unrecognized filenames — files: ${unrecognizedPreview()} — ` +
        'fix the file-analyzer agent to use only batch-<N>.json or batch-<N>-part-<K>.json patterns ' +
        '(every node/edge in these files was excluded from the final graph)',
    );
  }

  // Recover any imports edges file-analyzer batches dropped despite
  // `batchImportData` containing them. The project-scanner's importMap
  // is the deterministic source of truth.
  const [, recoveryReport] = recoverImportsFromScan(assembled, join(intermediateDir, 'scan-result.json'));
  if (recoveryReport.length) report.push('', 'Imports edge recovery:', ...recoveryReport);

  // Print report
  err('');
  for (const line of report) err(line);

  // Write output
  const outputPath = join(intermediateDir, 'assembled-graph.json');
  writeText(outputPath, dumps(assembled));

  err(`\nWritten to ${outputPath} (${kb(outputPath)} KB)`);

  // The old symbols live outside batch-existing.json, which intentionally
  // excludes reanalyzed files. Keep failed output as a diagnostic artifact,
  // but return failure so the orchestrator repairs it before publication.
  if (existsSync(planPath)) {
    const freshPlan = loadJson(planPath);
    if (isIncrementalAction(freshPlan)) {
      for (const k of ['baseCommit', 'headCommit']) if (!isDict(freshPlan) || !Object.hasOwn(freshPlan, k)) throw new Error(`KeyError: '${k}'`);
      const candidatePath = join(intermediateDir, 'incremental-edge-candidates.json');
      const candidateTemp = `${candidatePath}.tmp-${process.pid}`;
      writeText(candidateTemp, dumps({ baseCommit: freshPlan.baseCommit, headCommit: freshPlan.headCommit, edges: danglingCandidates }));
      renameSync(candidateTemp, candidatePath);
      const validator = join(dirname(fileURLToPath(import.meta.url)), 'validate-incremental-symbols.mjs');
      const result = spawnSync(process.execPath, [validator, projectRoot], { stdio: 'inherit' });
      if (result.error) throw result.error;
      const code = result.status ?? -(constants.signals[result.signal] ?? 1);
      if (code !== 0) process.exit(code);
    }
  }
}

if (import.meta.main) main();
