import { findChild, findChildren } from "./extractors/base-extractor.js";
import { unescaped } from "./symbol-ast.js";
import { FILE_SCOPE, UNKNOWN_SCOPE } from "./symbol-scopes.js";
const range = (node) => [node.startPosition.row + 1, node.endPosition.row + 1];
const plain = (text) => text && unescaped(text) ? text : null;
const classScope = (name) => name === null ? UNKNOWN_SCOPE : { kind: "class", name };
const PHP_CLASSES = new Set(["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration"]);
const DART_BODIES = new Map([["class_definition", "class_body"], ["mixin_declaration", "class_body"],
    ["extension_declaration", "extension_body"], ["enum_declaration", "enum_body"]]);
const DART_SIGNATURES = new Set(["function_signature", "getter_signature", "setter_signature", "constructor_signature",
    "constant_constructor_signature", "factory_constructor_signature", "redirecting_factory_constructor_signature"]);
const DART_VARIABLES = new Set(["initialized_identifier_list", "static_final_declaration_list"]);
function phpString(node) {
    return ["string", "encapsed_string"].includes(node?.type) && node.namedChildren.every(part => part.type === "string_content")
        ? plain(node.namedChildren.map(part => part.text).join("")) : null;
}
// ponytail: PHP runtime effects cover eval and class_alias only; extension installers such as runkit are not recognized.
function php(root, out) {
    const handled = new Set();
    const nameOf = (node) => plain(node.childForFieldName("name")?.text);
    const visit = (node, members) => {
        let inner = members;
        if (node.type === "function_definition") {
            out.callable(nameOf(node), FILE_SCOPE, node);
            inner = null;
        }
        else if (node.type === "method_declaration") {
            out.callable(nameOf(node), members ?? UNKNOWN_SCOPE, node);
            inner = null;
        }
        else if (PHP_CLASSES.has(node.type)) {
            const name = nameOf(node);
            out.class(name, node);
            inner = classScope(name);
        }
        else if (node.type === "anonymous_class") {
            inner = { kind: "local", id: node.id };
        }
        else if (node.type === "use_as_clause" && members) {
            const alias = node.namedChildren.at(-1);
            if (node.namedChildren.length > 1 && alias.type === "name")
                out.effect("callable", members, plain(alias.text), node, "PHP trait alias declaration");
        }
        else if (node.type === "function_call_expression") {
            const callee = node.childForFieldName("function");
            const name = ["name", "qualified_name"].includes(callee?.type) ? callee.text.split("\\").at(-1).toLowerCase() : null;
            if (name === "eval")
                out.effect(null, UNKNOWN_SCOPE, null, node, "Dynamic code evaluation");
            else if (name === "class_alias") {
                for (const part of [callee, ...callee.namedChildren])
                    handled.add(part.id);
                const alias = node.childForFieldName("arguments")?.namedChildren[1];
                out.effect("class", FILE_SCOPE, alias?.type === "argument" && !alias.childForFieldName("name")
                    ? phpString(alias.namedChildren[0]) : null, node, "Runtime class alias");
            }
        }
        else if (["name", "string_content"].includes(node.type) && !handled.has(node.id)
            && node.text.replace(/^\\/, "").toLowerCase() === "class_alias") {
            out.effect("class", UNKNOWN_SCOPE, null, node, "Aliased runtime class installer");
        }
        for (const child of node.namedChildren)
            visit(child, inner);
    };
    visit(root, null);
}
function dart(root, out) {
    const identifier = (node) => plain(findChild(node, "identifier")?.text);
    const signatureName = (sig) => {
        if (!sig.type.includes("constructor"))
            return identifier(sig);
        const ids = findChildren(findChild(sig, "qualified") ?? sig, "identifier").slice(0, 2);
        return ids.length ? plain(ids.map(id => id.text).join(".")) : null;
    };
    const variables = (list, scope, reason) => {
        for (const item of list.namedChildren)
            out.gap("callable", scope, identifier(item), item, reason);
    };
    for (const node of root.namedChildren) {
        if (["function_signature", "getter_signature", "setter_signature"].includes(node.type))
            out.callable(identifier(node), FILE_SCOPE, node);
        else if (DART_VARIABLES.has(node.type))
            variables(node, FILE_SCOPE, "Variable callability is not structurally verified");
        else if (node.type === "type_alias")
            out.gap(null, FILE_SCOPE, plain(findChild(node, "type_identifier")?.text), node, "Declaration surface is not covered: type_alias");
        else if (DART_BODIES.has(node.type)) {
            const target = node.type === "extension_declaration" ? findChild(node, "type_identifier") : null;
            const name = identifier(node) ?? (target ? `on ${target.text}` : null);
            out.class(name, node);
            const scope = classScope(name);
            for (const member of findChild(node, DART_BODIES.get(node.type))?.namedChildren ?? []) {
                if (!["method_signature", "declaration"].includes(member.type))
                    continue;
                const signature = member.namedChildren.find(child => DART_SIGNATURES.has(child.type));
                if (signature)
                    out.callable(signatureName(signature), scope, member);
                else
                    for (const list of member.namedChildren.filter(child => DART_VARIABLES.has(child.type)))
                        variables(list, scope, "Property callability is not structurally verified");
            }
        }
    }
}
const ADAPTERS = new Map([["php", php], ["dart", dart]]);
export function collectDeclarationEvidence(root, structure, language) {
    const adapter = ADAPTERS.get(language);
    if (!adapter)
        return null;
    const effects = [];
    const functions = [];
    const classes = [];
    const gaps = [];
    const usedFunctions = new Set();
    const usedClasses = new Set();
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    const entry = (kind, scope, name, node, reason) => ({ kind, scope, name, lineRange: range(node), reason });
    adapter(root, {
        callable(name, scope, node) {
            if (scope.kind === "local")
                return;
            const lineRange = range(node);
            const index = structure.functions.findIndex((fn, i) => !usedFunctions.has(i) && fn.owner === undefined
                && fn.name === name && same(fn.lineRange, lineRange));
            if (index >= 0) {
                usedFunctions.add(index);
                functions.push({ name, scope, lineRange });
            }
            else if (!(name !== null && scope.kind === "class"
                && structure.classes.some(cls => cls.name === scope.name && cls.methods.includes(name))))
                gaps.push(entry("callable", scope, name, node, "Callable declaration is not covered by structural extraction"));
        },
        class(name, node) {
            const lineRange = range(node);
            const index = structure.classes.findIndex((cls, i) => !usedClasses.has(i) && cls.name === name && same(cls.lineRange, lineRange));
            if (index >= 0) {
                usedClasses.add(index);
                classes.push({ name, scope: FILE_SCOPE, lineRange });
            }
            else
                gaps.push(entry("class", FILE_SCOPE, name, node, "Class declaration is not covered by structural extraction"));
        },
        gap: (kind, scope, name, node, reason) => gaps.push(entry(kind, scope, name, node, reason)),
        effect: (kind, scope, name, node, reason) => effects.push(entry(kind, scope, name, node, reason)),
    });
    structure.functions.forEach((fn, i) => {
        if (fn.owner === undefined && !usedFunctions.has(i))
            gaps.push({ kind: "callable", scope: UNKNOWN_SCOPE, name: fn.name, lineRange: fn.lineRange, reason: "Unresolved source receiver ownership" });
    });
    structure.classes.forEach((cls, i) => {
        if (usedClasses.has(i))
            return;
        gaps.push({ kind: "class", scope: UNKNOWN_SCOPE, name: cls.name, lineRange: cls.lineRange, reason: "Unresolved source class declaration" });
        for (const name of cls.methods)
            gaps.push({ kind: "callable", scope: UNKNOWN_SCOPE, name, lineRange: cls.lineRange, reason: "Unresolved source receiver ownership" });
    });
    return { version: 2, effects, functions, classes, coverage: { profile: "structural-declarations-v1", gaps } };
}
