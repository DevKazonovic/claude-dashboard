import { readFileSync, writeFileSync, mkdirSync, existsSync, linkSync, realpathSync, statSync, rmSync } from "node:fs";
import { join, isAbsolute, relative, basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { validateGraph } from "../schema.js";
const DATA_ROOT = join(homedir(), ".claude", "understand");
const GRAPH_FILE = "knowledge-graph.json";
const META_FILE = "meta.json";
const FINGERPRINT_FILE = "fingerprints.json";
const CONFIG_FILE = "config.json";
const slug = (s) => s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 60);
function ownerOf(dir) {
    try {
        return JSON.parse(readFileSync(join(dir, "project.json"), "utf-8")).projectRoot ?? null;
    }
    catch {
        return null;
    }
}
export function resolveUaDirName(projectRoot) {
    let root = resolve(projectRoot);
    let isDir = false;
    try {
        root = realpathSync(root);
        isDir = statSync(root).isDirectory();
    }
    catch { }
    const base = slug(basename(root)) || "project";
    const hash = createHash("sha1").update(root).digest("hex").slice(0, 6);
    const candidates = [base, slug(`${basename(dirname(root))}-${basename(root)}`) || base, `${base.slice(0, 53)}-${hash}`];
    for (const key of candidates) {
        const dir = join(DATA_ROOT, key);
        if (existsSync(dir) && ownerOf(dir) !== root)
            continue;
        if (!isDir)
            return key;
        mkdirSync(dir, { recursive: true });
        if (!existsSync(join(dir, "project.json"))) {
            const tmp = join(dir, `.project.json.${process.pid}.tmp`);
            writeFileSync(tmp, JSON.stringify({ key, projectRoot: root, createdAt: new Date().toISOString() }, null, 2) + "\n", "utf-8");
            try {
                linkSync(tmp, join(dir, "project.json"));
            }
            catch { }
            rmSync(tmp, { force: true });
            if (ownerOf(dir) !== root)
                continue;
        }
        return key;
    }
    throw new Error(`understand: no free data folder under ${DATA_ROOT} for ${root}`);
}
export function resolveUaDir(projectRoot) {
    return join(DATA_ROOT, resolveUaDirName(projectRoot));
}
function ensureDir(projectRoot) {
    const dir = resolveUaDir(projectRoot);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    return dir;
}
/**
 * Sanitise every node's filePath before writing to disk.
 *
 * The analysis agent produces absolute paths like:
 *   /Users/alice/company/src/auth.ts
 *
 * We convert them to paths relative to projectRoot:
 *   src/auth.ts
 *
 * Three cases are handled:
 *   1. Path is inside projectRoot      → make it relative
 *   2. Path is absolute but outside    → keep only the filename (last segment)
 *   3. Path is already relative        → leave it untouched
 *
 * This means the developer's home directory, username, and company
 * directory layout are never written to knowledge-graph.json.
 */
function sanitiseFilePaths(graph, projectRoot) {
    const normalRoot = projectRoot.endsWith("/")
        ? projectRoot
        : projectRoot + "/";
    const sanitisedNodes = graph.nodes.map((node) => {
        if (typeof node.filePath !== "string")
            return node;
        const fp = node.filePath;
        if (!isAbsolute(fp)) {
            // Already relative — nothing to do.
            return node;
        }
        if (fp.startsWith(normalRoot) || fp.startsWith(projectRoot)) {
            // Inside the project root — make it relative.
            return { ...node, filePath: relative(projectRoot, fp) };
        }
        // Absolute but outside the project root — use only the filename
        // so we leak as little as possible.
        return { ...node, filePath: basename(fp) };
    });
    return { ...graph, nodes: sanitisedNodes };
}
export function saveGraph(projectRoot, graph) {
    const dir = ensureDir(projectRoot);
    // FIX — sanitise absolute file paths before persisting.
    // Without this, absolute paths like /Users/alice/company/src/auth.ts
    // are written verbatim into knowledge-graph.json and later served
    // by the dashboard server, leaking the developer's directory layout.
    const sanitised = sanitiseFilePaths(graph, projectRoot);
    writeFileSync(join(dir, GRAPH_FILE), JSON.stringify(sanitised, null, 2), "utf-8");
}
export function loadGraph(projectRoot, options) {
    const filePath = join(resolveUaDir(projectRoot), GRAPH_FILE);
    if (!existsSync(filePath))
        return null;
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (options?.validate !== false) {
        const result = validateGraph(data);
        if (!result.success) {
            throw new Error(`Invalid knowledge graph: ${result.fatal ?? "unknown error"}`);
        }
        return result.data;
    }
    return data;
}
export function saveMeta(projectRoot, meta) {
    const dir = ensureDir(projectRoot);
    writeFileSync(join(dir, META_FILE), JSON.stringify(meta, null, 2), "utf-8");
}
export function loadMeta(projectRoot) {
    const filePath = join(resolveUaDir(projectRoot), META_FILE);
    if (!existsSync(filePath))
        return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
}
export function saveFingerprints(projectRoot, store) {
    const dir = ensureDir(projectRoot);
    writeFileSync(join(dir, FINGERPRINT_FILE), JSON.stringify(store, null, 2), "utf-8");
}
export function loadFingerprints(projectRoot) {
    const filePath = join(resolveUaDir(projectRoot), FINGERPRINT_FILE);
    if (!existsSync(filePath))
        return null;
    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    }
    catch {
        return null;
    }
}
const DEFAULT_CONFIG = { autoUpdate: false, outputLanguage: "en" };
export function saveConfig(projectRoot, config) {
    const dir = ensureDir(projectRoot);
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2), "utf-8");
}
export function loadConfig(projectRoot) {
    const filePath = join(resolveUaDir(projectRoot), CONFIG_FILE);
    if (!existsSync(filePath))
        return { ...DEFAULT_CONFIG };
    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    }
    catch {
        return { ...DEFAULT_CONFIG };
    }
}
const DOMAIN_GRAPH_FILE = "domain-graph.json";
export function saveDomainGraph(projectRoot, graph) {
    const dir = ensureDir(projectRoot);
    const sanitised = sanitiseFilePaths(graph, projectRoot);
    writeFileSync(join(dir, DOMAIN_GRAPH_FILE), JSON.stringify(sanitised, null, 2), "utf-8");
}
export function loadDomainGraph(projectRoot, options) {
    const filePath = join(resolveUaDir(projectRoot), DOMAIN_GRAPH_FILE);
    if (!existsSync(filePath))
        return null;
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (options?.validate !== false) {
        const result = validateGraph(data);
        if (!result.success) {
            throw new Error(`Invalid domain graph: ${result.fatal ?? "unknown error"}`);
        }
        return result.data;
    }
    return data;
}
