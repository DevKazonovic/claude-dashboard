import { findChild, findChildren } from "./base-extractor.js";
/** Node types that declare a Scala type (all map to `classes` in the graph). */
const TYPE_DEFINITION_KINDS = new Set([
    "class_definition",
    "trait_definition",
    "object_definition",
    "package_object",
    "enum_definition",
]);
/** Node types that declare a function (with or without a body). */
const FUNCTION_DEFINITION_KINDS = new Set([
    "function_definition",
    "function_declaration",
]);
/** Node types that declare a field/value member. */
const FIELD_DEFINITION_KINDS = new Set([
    "val_definition",
    "var_definition",
    "val_declaration",
    "var_declaration",
]);
/**
 * Extract the access-modifier text (e.g. "private", "private[pkg]") from a
 * declaration's `modifiers` child, or null when no access modifier is present.
 *
 * Scala's default visibility is public, so `null` means the declaration IS
 * exported — callers must treat absence as exported.
 */
function extractAccessModifier(declNode) {
    const modifiers = findChild(declNode, "modifiers");
    if (!modifiers)
        return null;
    const access = findChild(modifiers, "access_modifier");
    if (!access)
        return null;
    return access.text;
}
/**
 * Whether a Scala declaration is visible to other files.
 *
 * Default visibility is public, so a declaration with no access modifier
 * counts as exported. Only `private` (including `private[scope]`) opts out;
 * `protected` remains exported in the project-graph sense because it is
 * still resolvable from other files via inheritance.
 */
function isExported(declNode) {
    const access = extractAccessModifier(declNode);
    return access === null || !access.startsWith("private");
}
/**
 * Get the name of a Scala declaration: the first direct `identifier` child
 * (the keyword and optional modifiers precede it, type/value parameters
 * follow it).
 */
function extractDeclarationName(declNode) {
    for (let i = 0; i < declNode.childCount; i++) {
        const child = declNode.child(i);
        if (child && child.type === "identifier")
            return child.text;
    }
    return null;
}
/**
 * Extract parameter names from a function-like definition. Scala functions
 * may carry several parameter lists (currying / implicit / using clauses):
 * every direct `parameters` child contributes its `parameter` names in order.
 */
function extractParams(declNode) {
    const params = [];
    for (const paramList of findChildren(declNode, "parameters")) {
        for (const param of findChildren(paramList, "parameter")) {
            const id = findChild(param, "identifier");
            if (id)
                params.push(id.text);
        }
    }
    return params;
}
/**
 * Extract the declared return type from a function-like definition. The
 * grammar puts the return-type annotation as a direct `:` token followed by
 * a named type node (`def f(x: Int): IO[Unit] = ...`). Returns undefined
 * when the return type is inferred.
 */
function extractReturnType(declNode) {
    for (let i = 0; i < declNode.childCount; i++) {
        const child = declNode.child(i);
        if (!child || child.type !== ":")
            continue;
        for (let j = i + 1; j < declNode.childCount; j++) {
            const next = declNode.child(j);
            if (next && next.isNamed)
                return next.text;
        }
    }
    return undefined;
}
/**
 * Whether a `class_definition` is a case class (carries a leading `case`
 * keyword token). Case-class parameters are public vals, so they all count
 * as properties.
 */
function isCaseDefinition(declNode) {
    for (let i = 0; i < declNode.childCount; i++) {
        const child = declNode.child(i);
        if (child && child.type === "case")
            return true;
        if (child && child.type === "identifier")
            break;
    }
    return false;
}
/**
 * Collect constructor parameters that are properties. For case classes every
 * `class_parameter` is a public val; for regular classes only parameters
 * with an explicit `val` / `var` keyword become fields.
 */
function collectClassParameterProperties(declNode, properties) {
    const caseClass = isCaseDefinition(declNode);
    for (const paramList of findChildren(declNode, "class_parameters")) {
        for (const param of findChildren(paramList, "class_parameter")) {
            let isProperty = caseClass;
            if (!isProperty) {
                for (let i = 0; i < param.childCount; i++) {
                    const child = param.child(i);
                    if (child && (child.type === "val" || child.type === "var")) {
                        isProperty = true;
                        break;
                    }
                }
            }
            if (!isProperty)
                continue;
            const id = findChild(param, "identifier");
            if (id)
                properties.push(id.text);
        }
    }
}
/**
 * Extract the name of a val/var member. The grammar puts the binding name
 * as a direct `identifier` child (tuple/pattern bindings have no single
 * identifier and are skipped).
 */
function extractFieldName(fieldNode) {
    return extractDeclarationName(fieldNode);
}
/**
 * Scala extractor for tree-sitter structural analysis and call graph
 * extraction. Covers Scala 2 and Scala 3 syntax: classes, case classes,
 * traits, objects, enums, top-level and member functions, extension
 * methods, and the three import shapes (plain, selector list, wildcard).
 */
export class ScalaExtractor {
    languageIds = ["scala"];
    extractStructure(rootNode) {
        const functions = [];
        const classes = [];
        const imports = [];
        const exports = [];
        this.walkTopLevel(rootNode, functions, classes, imports, exports);
        return { functions, classes, imports, exports };
    }
    extractCallGraph(rootNode) {
        const entries = [];
        const functionStack = [];
        const walk = (node) => {
            let pushed = false;
            if (node.type === "function_definition") {
                const name = extractDeclarationName(node);
                if (name) {
                    functionStack.push(name);
                    pushed = true;
                }
            }
            if (functionStack.length > 0) {
                const callee = this.extractCallLikeName(node);
                if (callee) {
                    entries.push({
                        caller: functionStack[functionStack.length - 1],
                        callee,
                        lineNumber: node.startPosition.row + 1,
                    });
                }
            }
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child)
                    walk(child);
            }
            if (pushed)
                functionStack.pop();
        };
        walk(rootNode);
        return entries;
    }
    // ---- Private helpers ----
    /**
     * Walk the direct children of the compilation unit (or of a braceless
     * `package foo { ... }` / top-level region) and dispatch declarations.
     */
    walkTopLevel(node, functions, classes, imports, exports) {
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (!child)
                continue;
            if (child.type === "package_clause") {
                // Package is metadata about this file, not a graph member — but a
                // `package foo { ... }` block nests real declarations underneath.
                this.walkTopLevel(child, functions, classes, imports, exports);
            }
            else if (child.type === "template_body") {
                // Braced package clauses wrap top-level declarations in a template body.
                this.walkTopLevel(child, functions, classes, imports, exports);
            }
            else if (child.type === "import_declaration") {
                this.extractImport(child, imports);
            }
            else if (child.type === "export_declaration") {
                this.extractExportDeclaration(child, exports);
            }
            else if (FUNCTION_DEFINITION_KINDS.has(child.type)) {
                this.extractFunction(child, functions, exports);
            }
            else if (TYPE_DEFINITION_KINDS.has(child.type)) {
                this.extractTypeDefinition(child, classes, functions, exports);
            }
            else if (FIELD_DEFINITION_KINDS.has(child.type)) {
                // Scala 3 top-level val/var
                const name = extractFieldName(child);
                if (name && isExported(child)) {
                    exports.push({ name, lineNumber: child.startPosition.row + 1 });
                }
            }
            else if (child.type === "extension_definition") {
                // Extension methods are surfaced as top-level functions.
                this.extractExtensionDefinition(child, null, functions, exports);
            }
            else if (child.type === "given_definition") {
                const name = extractDeclarationName(child);
                if (name && isExported(child)) {
                    exports.push({ name, lineNumber: child.startPosition.row + 1 });
                }
            }
        }
    }
    extractFunction(declNode, functions, exports, exportAllowed = true) {
        const name = extractDeclarationName(declNode);
        if (!name)
            return;
        functions.push({
            name,
            lineRange: [declNode.startPosition.row + 1, declNode.endPosition.row + 1],
            params: extractParams(declNode),
            returnType: extractReturnType(declNode),
        });
        if (exportAllowed && isExported(declNode)) {
            exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
        }
    }
    /**
     * Extract a class / trait / object / enum definition. Nested type
     * definitions inside the body (the companion-object ADT idiom:
     * `object Command { case class Create(...) }`) are recursed into and
     * surfaced as their own class entries.
     */
    extractTypeDefinition(declNode, classes, functions, exports, exportAllowed = true) {
        const name = extractDeclarationName(declNode);
        if (!name)
            return;
        const properties = [];
        const methods = [];
        const memberExportAllowed = exportAllowed && isExported(declNode);
        // 1. Constructor `val`/`var` (and all case-class) parameters.
        collectClassParameterProperties(declNode, properties);
        // 2. Body members, if any (`class Empty` / `case class Point(...)`
        //    have no template_body). Enums keep cases in an `enum_body`.
        const body = findChild(declNode, "template_body") ?? findChild(declNode, "enum_body");
        if (body) {
            this.collectTemplateBody(body, methods, properties, classes, functions, exports, memberExportAllowed);
        }
        classes.push({
            name,
            lineRange: [declNode.startPosition.row + 1, declNode.endPosition.row + 1],
            methods,
            properties,
        });
        if (memberExportAllowed) {
            exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
        }
    }
    /**
     * Walk a `template_body` / `enum_body` and collect member functions and
     * fields. Function entries are added to both the type's `methods` array
     * and the top-level `functions` array (matching the Go / Swift / Kotlin
     * extractor convention).
     */
    collectTemplateBody(body, methods, properties, classes, functions, exports, exportAllowed = true) {
        for (let i = 0; i < body.childCount; i++) {
            const member = body.child(i);
            if (!member)
                continue;
            if (FUNCTION_DEFINITION_KINDS.has(member.type)) {
                const name = extractDeclarationName(member);
                if (!name)
                    continue;
                methods.push(name);
                functions.push({
                    name,
                    lineRange: [member.startPosition.row + 1, member.endPosition.row + 1],
                    params: extractParams(member),
                    returnType: extractReturnType(member),
                });
                if (exportAllowed && isExported(member)) {
                    exports.push({ name, lineNumber: member.startPosition.row + 1 });
                }
            }
            else if (FIELD_DEFINITION_KINDS.has(member.type)) {
                const name = extractFieldName(member);
                if (!name)
                    continue;
                properties.push(name);
                if (exportAllowed && isExported(member)) {
                    exports.push({ name, lineNumber: member.startPosition.row + 1 });
                }
            }
            else if (TYPE_DEFINITION_KINDS.has(member.type)) {
                this.extractTypeDefinition(member, classes, functions, exports, exportAllowed);
            }
            else if (member.type === "extension_definition") {
                this.extractExtensionDefinition(member, methods, functions, exports, exportAllowed);
            }
            else if (member.type === "enum_case_definitions") {
                // `case Red, Green` inside an enum body — each case is a property.
                for (let j = 0; j < member.childCount; j++) {
                    const enumCase = member.child(j);
                    if (!enumCase || !enumCase.isNamed)
                        continue;
                    const id = findChild(enumCase, "identifier");
                    if (id)
                        properties.push(id.text);
                }
            }
        }
    }
    /**
     * Extract a Scala import. The dotted prefix is a run of direct
     * `identifier` children; the trailing element decides the shape:
     *
     * - `import cats.effect.IO`          → source="cats.effect.IO", specifiers=["IO"]
     * - `import cats.effect._` / `.*`    → source="cats.effect",    specifiers=["*"]
     * - `import a.{B, C => D, E as F}`   → source="a",               specifiers=["B", "D", "F"]
     */
    extractImport(declNode, imports) {
        const itemChildren = [];
        let current = [];
        for (let i = 0; i < declNode.childCount; i++) {
            const child = declNode.child(i);
            if (!child)
                continue;
            if (child.type === ",") {
                if (current.length > 0)
                    itemChildren.push(current);
                current = [];
            }
            else if (child.isNamed) {
                current.push(child);
            }
        }
        if (current.length > 0)
            itemChildren.push(current);
        for (const item of itemChildren) {
            this.extractImportItem(item, declNode.startPosition.row + 1, imports);
        }
    }
    extractImportItem(itemChildren, lineNumber, imports) {
        const parts = [];
        for (const child of itemChildren) {
            if (child.type === "identifier")
                parts.push(child.text);
        }
        const selectors = itemChildren.find((child) => child.type === "namespace_selectors");
        const wildcard = itemChildren.find((child) => child.type === "namespace_wildcard");
        let source;
        let specifiers;
        if (wildcard) {
            if (parts.length === 0)
                return;
            source = parts.join(".");
            specifiers = ["*"];
        }
        else if (selectors) {
            if (parts.length === 0)
                return;
            source = parts.join(".");
            specifiers = this.extractSelectorSpecifiers(selectors);
            if (specifiers.length === 0)
                specifiers = ["*"];
        }
        else {
            if (parts.length === 0)
                return;
            source = parts.join(".");
            specifiers = [parts[parts.length - 1]];
        }
        imports.push({
            source,
            specifiers,
            lineNumber,
        });
    }
    /**
     * Extract the imported names from a `{ ... }` selector list. Renames
     * (`A => B` in Scala 2, `A as B` in Scala 3) surface the source name so
     * file resolution can still probe `A.scala`; excluded `A => _` selectors
     * are skipped. `given` / `*` selectors surface as "*".
     */
    extractSelectorSpecifiers(selectors) {
        const specifiers = [];
        for (let i = 0; i < selectors.childCount; i++) {
            const child = selectors.child(i);
            if (!child || !child.isNamed)
                continue;
            if (child.type === "identifier") {
                specifiers.push(child.text);
            }
            else if (child.type === "namespace_wildcard") {
                specifiers.push("*");
            }
            else {
                // Renamed selector (arrow_renamed_identifier / as_renamed_identifier):
                // the source name is the FIRST identifier child.
                if (findChild(child, "wildcard"))
                    continue;
                const ids = findChildren(child, "identifier");
                if (ids.length > 0)
                    specifiers.push(ids[0].text);
            }
        }
        return specifiers;
    }
    extractExtensionDefinition(declNode, methods, functions, exports, exportAllowed = true) {
        for (const fn of findChildren(declNode, "function_definition")) {
            const name = extractDeclarationName(fn);
            if (name && methods)
                methods.push(name);
            this.extractFunction(fn, functions, exports, exportAllowed);
        }
    }
    extractExportDeclaration(declNode, exports) {
        const selectors = findChild(declNode, "namespace_selectors");
        const names = selectors
            ? this.extractExportSelectorNames(selectors)
            : this.extractExportedPathName(declNode);
        for (const name of names) {
            if (name !== "*") {
                exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
            }
        }
    }
    extractExportSelectorNames(selectors) {
        const names = [];
        for (let i = 0; i < selectors.childCount; i++) {
            const child = selectors.child(i);
            if (!child || !child.isNamed)
                continue;
            if (child.type === "identifier") {
                names.push(child.text);
            }
            else if (child.type === "namespace_wildcard") {
                names.push("*");
            }
            else if (!findChild(child, "wildcard")) {
                const ids = findChildren(child, "identifier");
                if (ids.length > 0)
                    names.push(ids[ids.length - 1].text);
            }
        }
        return names;
    }
    extractExportedPathName(declNode) {
        let name = null;
        for (const id of findChildren(declNode, "identifier")) {
            name = id.text;
        }
        return name ? [name] : [];
    }
    /**
     * Extract the callee name from a Scala `call_expression`. Shapes:
     *
     *   foo(...)                → identifier "foo"
     *   target.method(...)      → field_expression whose last identifier is
     *                             the method name
     *   foo[T](...) / x.f[T](…) → generic_function wrapping either shape
     */
    extractCallLikeName(node) {
        if (node.type === "call_expression")
            return this.extractCalleeName(node);
        if (node.type === "infix_expression")
            return this.extractInfixName(node);
        if (node.type === "instance_expression")
            return this.extractConstructorName(node);
        return null;
    }
    extractCalleeName(callNode) {
        let target = callNode.child(0);
        if (!target)
            return null;
        if (target.type === "generic_function") {
            target = target.child(0);
            if (!target)
                return null;
        }
        if (target.type === "identifier")
            return target.text;
        if (target.type === "field_expression") {
            let lastIdentifier = null;
            for (let i = 0; i < target.childCount; i++) {
                const child = target.child(i);
                if (child && child.type === "identifier") {
                    lastIdentifier = child.text;
                }
            }
            return lastIdentifier;
        }
        return null;
    }
    extractInfixName(infixNode) {
        const identifiers = [];
        for (let i = 0; i < infixNode.childCount; i++) {
            const child = infixNode.child(i);
            if (child && child.type === "identifier")
                identifiers.push(child.text);
        }
        return identifiers[1] ?? identifiers[0] ?? null;
    }
    extractConstructorName(instanceNode) {
        for (let i = 0; i < instanceNode.childCount; i++) {
            const child = instanceNode.child(i);
            if (child && (child.type === "type_identifier" || child.type === "identifier")) {
                return child.text;
            }
        }
        return null;
    }
}
