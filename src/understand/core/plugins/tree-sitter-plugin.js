import { createRequire } from "node:module";
import { dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSymbolEvidence } from "./symbol-evidence.js";
import { builtinExtractors } from "./extractors/index.js";
// web-tree-sitter uses CJS internally; we need createRequire for .wasm resolution
const require = createRequire(import.meta.url);
// ponytail: regex SFC split; a literal "</script>" inside script code or a <script> tag inside an HTML comment breaks it. Switch to @vue/compiler-sfc if that ever shows up.
const VUE_SCRIPT = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
function vueScript(content) {
    let out = content.replace(/[^\r\n]/g, " ");
    let langKey = "javascript";
    for (const m of content.matchAll(VUE_SCRIPT)) {
        const lang = /\blang\s*=\s*["']?([\w-]+)/i.exec(m[1])?.[1].toLowerCase();
        if (lang === "tsx")
            langKey = "tsx";
        else if (lang === "ts" && langKey === "javascript")
            langKey = "typescript";
        const start = m.index + 8 + m[1].length;
        out = out.slice(0, start) + m[2] + out.slice(start + m[2].length);
    }
    return { langKey, content: out };
}
/**
 * Config-driven tree-sitter plugin.
 *
 * Accepts LanguageConfig objects to determine which languages to support
 * and how to load their WASM grammars. Provides deep structural analysis
 * (functions, classes, imports, exports, call graphs) for all languages
 * with registered extractors: TypeScript, JavaScript, Python, Go, Rust,
 * Java, Ruby, PHP, C/C++, C#, Dart, Kotlin, Swift, and Scala.
 *
 * Languages without tree-sitter configs are gracefully skipped (the LLM
 * agent handles analysis for those).
 */
export class TreeSitterPlugin {
    name = "tree-sitter";
    languages;
    configs;
    // Pre-loaded parser constructor and languages (set by init())
    _ParserClass = null;
    _languages = new Map();
    _extensionToLang = new Map();
    // One reusable parser per language key. web-tree-sitter parsers are reusable
    // across parse() calls (only the Tree is per-parse, and it's still deleted);
    // creating + setLanguage + delete on every call wasted an allocation and a
    // WASM setLanguage on every file. Cached here, created lazily on first use.
    _parsers = new Map();
    _initialized = false;
    // Language-specific extractors (keyed by language id)
    extractors = new Map();
    /**
     * Create a TreeSitterPlugin with the given language configs.
     * Only configs that have a `treeSitter` field will be loaded.
     * If no configs are provided, defaults to TypeScript and JavaScript.
     *
     * @param configs Language configurations to load
     * @param extractors Optional language extractors; if none provided, registers all builtin extractors
     */
    constructor(configs, extractors) {
        if (configs) {
            this.configs = configs.filter((c) => c.treeSitter);
        }
        else {
            // Default: TS/JS for backward compatibility
            this.configs = [];
        }
        // Derive supported languages and extension map from configs
        const langs = [];
        for (const config of this.configs) {
            langs.push(config.id);
            for (const ext of config.extensions) {
                const key = ext.startsWith(".") ? ext : `.${ext}`;
                this._extensionToLang.set(key, config.id);
            }
        }
        // Fallback for backward compat when no configs provided
        if (langs.length === 0) {
            langs.push("typescript", "javascript");
            this._extensionToLang.set(".ts", "typescript");
            this._extensionToLang.set(".tsx", "typescript");
            this._extensionToLang.set(".js", "javascript");
            this._extensionToLang.set(".mjs", "javascript");
            this._extensionToLang.set(".cjs", "javascript");
            this._extensionToLang.set(".jsx", "javascript");
        }
        this.languages = langs;
        // Register extractors (default: all builtin extractors)
        if (extractors && extractors.length > 0) {
            for (const extractor of extractors) {
                this.registerExtractor(extractor);
            }
        }
        else {
            for (const extractor of builtinExtractors) {
                this.registerExtractor(extractor);
            }
        }
    }
    registerExtractor(extractor) {
        for (const id of extractor.languageIds) {
            this.extractors.set(id, extractor);
        }
    }
    getExtractor(langKey) {
        // tsx is a synthetic grammar key — extraction logic is identical to typescript
        const key = langKey === "tsx" ? "typescript" : langKey;
        return this.extractors.get(key) ?? null;
    }
    languageKeyFromPath(filePath) {
        const ext = extname(filePath).toLowerCase();
        // Special case: .tsx needs its own grammar
        if (ext === ".tsx")
            return "tsx";
        return this._extensionToLang.get(ext) ?? null;
    }
    source(filePath, content) {
        const langKey = this.languageKeyFromPath(filePath);
        return langKey === "vue" ? vueScript(content) : { langKey, content };
    }
    /**
     * Initialize the plugin by loading the WASM module and all language grammars.
     * Must be called (and awaited) before any synchronous methods.
     */
    async init() {
        if (this._initialized)
            return;
        const mod = await import("web-tree-sitter");
        const ParserCls = mod.Parser;
        const LanguageCls = mod.Language;
        await ParserCls.init();
        this._ParserClass = ParserCls;
        if (this.configs.length > 0) {
            // Load grammars from configs
            const loadPromises = [];
            for (const config of this.configs) {
                if (!config.treeSitter || config.id === "vue")
                    continue;
                const loadGrammar = async () => {
                    try {
                        const wasmPath = config.treeSitter.wasmPackage.startsWith("@understand-anything/")
                            ? fileURLToPath(new URL(`../../grammars/${config.treeSitter.wasmFile}`, import.meta.url))
                            : require.resolve(`${config.treeSitter.wasmPackage}/${config.treeSitter.wasmFile}`);
                        const lang = await LanguageCls.load(wasmPath);
                        this._languages.set(config.id, lang);
                        // Special handling for TypeScript: also load TSX grammar
                        if (config.id === "typescript") {
                            try {
                                const tsxWasm = require.resolve(`${config.treeSitter.wasmPackage}/tree-sitter-tsx.wasm`);
                                const tsxLang = await LanguageCls.load(tsxWasm);
                                this._languages.set("tsx", tsxLang);
                            }
                            catch {
                                // TSX grammar not available; .tsx files will fall back to TS grammar
                            }
                        }
                    }
                    catch {
                        // Grammar not available — this language will be skipped gracefully
                        console.debug?.(`tree-sitter: Could not load grammar for ${config.id}, skipping structural analysis`);
                    }
                };
                loadPromises.push(loadGrammar());
            }
            await Promise.all(loadPromises);
        }
        else {
            // Legacy fallback: load TS/JS grammars directly
            const tsWasm = require.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm");
            const tsxWasm = require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm");
            const jsWasm = require.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm");
            const [tsLang, tsxLang, jsLang] = await Promise.all([
                LanguageCls.load(tsWasm),
                LanguageCls.load(tsxWasm),
                LanguageCls.load(jsWasm),
            ]);
            this._languages.set("typescript", tsLang);
            this._languages.set("tsx", tsxLang);
            this._languages.set("javascript", jsLang);
        }
        this._initialized = true;
    }
    /**
     * Create a parser set to the appropriate language for the given file.
     * This is synchronous because all languages are pre-loaded during init().
     */
    getParser(langKey) {
        if (!this._initialized || !this._ParserClass) {
            throw new Error("TreeSitterPlugin.init() must be called before use");
        }
        if (!langKey)
            return null;
        const lang = this._languages.get(langKey);
        if (!lang) {
            // Language grammar not loaded — graceful degradation
            return null;
        }
        let parser = this._parsers.get(langKey);
        if (!parser) {
            parser = new this._ParserClass();
            parser.setLanguage(lang);
            this._parsers.set(langKey, parser);
        }
        return parser;
    }
    // Fresh object AND fresh arrays on every call — a shared static would leak
    // the same array instances to every caller, so one caller mutating its
    // result would corrupt everyone else's.
    static emptyStructure() {
        return { functions: [], classes: [], imports: [], exports: [] };
    }
    analyzeFile(filePath, content) {
        const src = this.source(filePath, content);
        const parser = this.getParser(src.langKey);
        if (!parser) {
            return { functions: [], classes: [], imports: [], exports: [] };
        }
        const tree = parser.parse(src.content);
        if (!tree) {
            return { functions: [], classes: [], imports: [], exports: [] };
        }
        const langKey = src.langKey;
        const extractor = langKey ? this.getExtractor(langKey) : null;
        let result;
        if (extractor) {
            result = extractor.extractStructure(tree.rootNode);
        }
        else {
            result = { functions: [], classes: [], imports: [], exports: [] };
        }
        tree.delete();
        return result;
    }
    /**
     * Evidence for destructive structural comparisons. Unlike analyzeFile's
     * best-effort contract, an unavailable grammar or a recovered syntax error
     * must never look like a successfully parsed file with no symbols.
     * Supplemental declarations retain their name and owner, so uncertainty
     * cannot leak from an unrelated class or an ordinary source-code token.
     */
    analyzeFileStrict(filePath, content) {
        let tree = null;
        try {
            const src = this.source(filePath, content);
            const parser = this.getParser(src.langKey);
            const langKey = src.langKey;
            const extractor = langKey ? this.getExtractor(langKey) : null;
            if (!parser || !extractor) {
                return { status: "unsupported", structure: null, symbolEvidence: null };
            }
            tree = parser.parse(src.content);
            if (!tree || tree.rootNode.hasError) {
                return { status: "failed", structure: null, symbolEvidence: null };
            }
            const structure = extractor.extractStructure(tree.rootNode);
            return {
                status: "succeeded",
                language: langKey,
                structure,
                symbolEvidence: collectSymbolEvidence(tree.rootNode, structure, langKey),
            };
        }
        catch {
            return { status: "failed", structure: null, symbolEvidence: null };
        }
        finally {
            tree?.delete();
        }
    }
    /**
     * Parse the file ONCE and return both structural analysis and the call
     * graph. `extract-structure.mjs` runs `analyzeFile` then `extractCallGraph`
     * on every code file — two full tree-sitter parses of identical content.
     * Both extractors are pure functions of the same rootNode, so a single
     * parse yields byte-identical results (verified) at ~40% less parse work
     * on the indexing hot path. Callers without this method fall back to the
     * two separate calls.
     */
    analyzeFileFull(filePath, content) {
        const src = this.source(filePath, content);
        const parser = this.getParser(src.langKey);
        if (!parser) {
            return { structure: TreeSitterPlugin.emptyStructure(), callGraph: [] };
        }
        const tree = parser.parse(src.content);
        if (!tree) {
            return { structure: TreeSitterPlugin.emptyStructure(), callGraph: [] };
        }
        const langKey = src.langKey;
        const extractor = langKey ? this.getExtractor(langKey) : null;
        const structure = extractor
            ? extractor.extractStructure(tree.rootNode)
            : TreeSitterPlugin.emptyStructure();
        const callGraph = extractor ? extractor.extractCallGraph(tree.rootNode) : [];
        tree.delete();
        return { structure, callGraph };
    }
    resolveImports(filePath, content) {
        const analysis = this.analyzeFile(filePath, content);
        const dir = dirname(filePath);
        return analysis.imports.map((imp) => {
            let resolvedPath;
            if (imp.source.startsWith("./") ||
                imp.source.startsWith("../")) {
                resolvedPath = resolve(dir, imp.source);
            }
            else {
                resolvedPath = imp.source;
            }
            return {
                source: imp.source,
                resolvedPath,
                specifiers: imp.specifiers,
            };
        });
    }
    extractCallGraph(filePath, content) {
        const src = this.source(filePath, content);
        const parser = this.getParser(src.langKey);
        if (!parser)
            return [];
        const tree = parser.parse(src.content);
        if (!tree) {
            return [];
        }
        const langKey = src.langKey;
        const extractor = langKey ? this.getExtractor(langKey) : null;
        const result = extractor ? extractor.extractCallGraph(tree.rootNode) : [];
        tree.delete();
        return result;
    }
}
