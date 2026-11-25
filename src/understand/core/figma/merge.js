import { validateGraph } from "../schema.js";
const DS_TYPES = new Set(["component", "componentSet", "token"]);
export function mergeDesignGraph(manifest, analyses, project) {
    // 1. index manifest nodes (clone so we can enrich)
    const byId = new Map();
    for (const n of manifest.nodes)
        byId.set(n.id, { ...n });
    const edges = [...manifest.edges];
    // 2. apply LLM enrichment; design-analyzer must not invent structural nodes
    for (const a of analyses) {
        for (const patch of a.nodes ?? []) {
            const base = byId.get(patch.id);
            if (!base)
                continue;
            if (patch.summary)
                base.summary = patch.summary;
            if (patch.tags && patch.tags.length)
                base.tags = patch.tags;
        }
        for (const e of a.edges ?? [])
            edges.push(e);
    }
    const nodes = [...byId.values()];
    // 3. layers: one per page (+ descendants), plus a Design System layer
    const parent = new Map();
    for (const e of manifest.edges)
        if (e.type === "contains")
            parent.set(e.target, e.source);
    const pageOf = (id) => {
        let cur = id;
        const guard = new Set();
        while (cur && !guard.has(cur)) {
            guard.add(cur);
            if (byId.get(cur)?.type === "page")
                return cur;
            cur = parent.get(cur);
        }
        return undefined;
    };
    const layerMap = new Map();
    const ds = [];
    for (const n of nodes) {
        if (DS_TYPES.has(n.type)) {
            ds.push(n.id);
            continue;
        }
        const key = n.type === "page" ? n.id : (pageOf(n.id) ?? "layer:unscoped");
        if (!layerMap.has(key))
            layerMap.set(key, []);
        layerMap.get(key).push(n.id);
    }
    const layers = [];
    for (const [pageId, ids] of layerMap) {
        const pageNode = byId.get(pageId);
        layers.push({
            id: `layer:${pageId}`,
            name: pageNode?.name ?? "Unscoped",
            description: pageNode ? `Figma page: ${pageNode.name}` : "Nodes not under a page",
            nodeIds: ids,
        });
    }
    if (ds.length) {
        layers.push({ id: "layer:design-system", name: "Design System", description: "Components, variants, and design tokens", nodeIds: ds });
    }
    // 4. tour: Design System first, then each page
    const tour = [];
    let order = 1;
    if (ds.length)
        tour.push({ order: order++, title: "Design System", description: "Shared components, variants, and tokens the screens are built from.", nodeIds: ds.slice(0, 8) });
    for (const l of layers) {
        if (l.id === "layer:design-system")
            continue;
        tour.push({ order: order++, title: l.name, description: `Screens on the "${l.name}" page.`, nodeIds: l.nodeIds.slice(0, 8) });
    }
    // 5. assemble + validate, then re-attach kind (validateGraph drops it)
    const graph = { version: "1.0.0", kind: "design", project, nodes, edges, layers, tour };
    const result = validateGraph(graph);
    if (result.success && result.data) {
        result.data.kind = "design";
    }
    return result;
}
