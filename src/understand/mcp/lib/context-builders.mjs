import { SearchEngine } from "../../core/index.js";

/**
 * Build a ChatContext by searching the knowledge graph for nodes relevant
 * to the user's query, expanding 1 hop via edges, and collecting the
 * associated layers.
 */
export function buildChatContext(graph, query, maxNodes) {
    const limit = maxNodes ?? 15;
    // 1. Use SearchEngine to find relevant nodes
    const engine = new SearchEngine(graph.nodes);
    const searchResults = engine.search(query, { limit });
    // Build a set of matched node IDs
    const matchedIds = new Set(searchResults.map((r) => r.nodeId));
    // 2. Expand to connected nodes (1 hop via edges)
    const expandedIds = new Set(matchedIds);
    for (const edge of graph.edges) {
        if (matchedIds.has(edge.source)) {
            expandedIds.add(edge.target);
        }
        if (matchedIds.has(edge.target)) {
            expandedIds.add(edge.source);
        }
    }
    // Collect the actual node objects
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const relevantNodes = [];
    for (const id of expandedIds) {
        const node = nodeMap.get(id);
        if (node) {
            relevantNodes.push(node);
        }
    }
    // 3. Collect edges where both endpoints are in the relevant set
    const relevantEdges = graph.edges.filter((e) => expandedIds.has(e.source) && expandedIds.has(e.target));
    // 4. Find layers containing any relevant node
    const relevantLayers = graph.layers.filter((layer) => layer.nodeIds.some((id) => expandedIds.has(id)));
    return {
        projectName: graph.project.name,
        projectDescription: graph.project.description,
        languages: graph.project.languages,
        frameworks: graph.project.frameworks,
        relevantNodes,
        relevantEdges,
        relevantLayers,
        query,
    };
}
/**
 * Format the ChatContext as a readable markdown string for LLM consumption.
 */
export function formatContextForPrompt(context) {
    const lines = [];
    // Project header
    lines.push(`# Project: ${context.projectName}`);
    lines.push("");
    lines.push(context.projectDescription);
    lines.push("");
    lines.push(`**Languages:** ${context.languages.join(", ")}`);
    lines.push(`**Frameworks:** ${context.frameworks.join(", ")}`);
    lines.push("");
    // Layers section
    if (context.relevantLayers.length > 0) {
        lines.push("## Relevant Layers");
        lines.push("");
        for (const layer of context.relevantLayers) {
            lines.push(`### ${layer.name}`);
            lines.push(layer.description);
            lines.push("");
        }
    }
    // Nodes section
    if (context.relevantNodes.length > 0) {
        lines.push("## Code Components");
        lines.push("");
        for (const node of context.relevantNodes) {
            lines.push(`### ${node.name} (${node.type})`);
            if (node.filePath) {
                lines.push(`- **File:** ${node.filePath}`);
            }
            lines.push(`- **Complexity:** ${node.complexity}`);
            lines.push(`- **Summary:** ${node.summary}`);
            if (node.tags.length > 0) {
                lines.push(`- **Tags:** ${node.tags.join(", ")}`);
            }
            if (node.languageNotes) {
                lines.push(`- **Language Notes:** ${node.languageNotes}`);
            }
            lines.push("");
        }
    }
    // Edges/relationships section
    if (context.relevantEdges.length > 0) {
        const nodeMap = new Map(context.relevantNodes.map((n) => [n.id, n]));
        lines.push("## Relationships");
        lines.push("");
        for (const edge of context.relevantEdges) {
            const sourceName = nodeMap.get(edge.source)?.name ?? edge.source;
            const targetName = nodeMap.get(edge.target)?.name ?? edge.target;
            let line = `- ${sourceName} --[${edge.type}]--> ${targetName}`;
            if (edge.description) {
                line += `: ${edge.description}`;
            }
            lines.push(line);
        }
        lines.push("");
    }
    return lines.join("\n");
}

/**
 * Map a list of changed file paths to knowledge graph nodes and
 * identify the ripple effect (affected nodes, layers, edges).
 */
export function buildDiffContext(graph, changedFiles) {
    const { nodes, edges, layers } = graph;
    const changedNodeIds = new Set();
    const unmappedFiles = [];
    for (const file of changedFiles) {
        let mapped = false;
        for (const node of nodes) {
            if (node.filePath === file) {
                changedNodeIds.add(node.id);
                mapped = true;
            }
        }
        if (!mapped) {
            unmappedFiles.push(file);
        }
    }
    // Also include "contains" children of changed file nodes
    for (const edge of edges) {
        if (edge.type === "contains" && changedNodeIds.has(edge.source)) {
            changedNodeIds.add(edge.target);
        }
    }
    const changedNodes = nodes.filter((n) => changedNodeIds.has(n.id));
    // Find affected nodes: 1-hop neighbors of changed nodes (excluding already changed)
    const affectedNodeIds = new Set();
    const impactedEdges = [];
    for (const edge of edges) {
        const sourceChanged = changedNodeIds.has(edge.source);
        const targetChanged = changedNodeIds.has(edge.target);
        if (sourceChanged || targetChanged) {
            impactedEdges.push(edge);
            if (sourceChanged && !changedNodeIds.has(edge.target)) {
                affectedNodeIds.add(edge.target);
            }
            if (targetChanged && !changedNodeIds.has(edge.source)) {
                affectedNodeIds.add(edge.source);
            }
        }
    }
    const affectedNodes = nodes.filter((n) => affectedNodeIds.has(n.id));
    const allImpactedIds = new Set([...changedNodeIds, ...affectedNodeIds]);
    const affectedLayers = layers.filter((layer) => layer.nodeIds.some((id) => allImpactedIds.has(id)));
    return {
        projectName: graph.project.name,
        changedFiles,
        changedNodes,
        affectedNodes,
        impactedEdges,
        affectedLayers,
        unmappedFiles,
    };
}
/**
 * Format the diff analysis as structured markdown for LLM or human consumption.
 */
export function formatDiffAnalysis(ctx) {
    const lines = [];
    lines.push(`# Diff Analysis: ${ctx.projectName}`);
    lines.push("");
    lines.push("## Changed Components");
    lines.push("");
    if (ctx.changedNodes.length === 0) {
        lines.push("No mapped components found for changed files.");
    }
    else {
        for (const node of ctx.changedNodes) {
            lines.push(`- **${node.name}** (${node.type}): ${node.summary}`);
            if (node.filePath)
                lines.push(`  - File: \`${node.filePath}\``);
            lines.push(`  - Complexity: ${node.complexity}`);
        }
    }
    lines.push("");
    lines.push("## Affected Components");
    lines.push("");
    if (ctx.affectedNodes.length === 0) {
        lines.push("No downstream impact detected.");
    }
    else {
        lines.push("These components are connected to changed code and may need attention:");
        lines.push("");
        for (const node of ctx.affectedNodes) {
            lines.push(`- **${node.name}** (${node.type}): ${node.summary}`);
        }
    }
    lines.push("");
    lines.push("## Affected Layers");
    lines.push("");
    if (ctx.affectedLayers.length === 0) {
        lines.push("No layers affected.");
    }
    else {
        for (const layer of ctx.affectedLayers) {
            lines.push(`- **${layer.name}**: ${layer.description}`);
        }
    }
    lines.push("");
    if (ctx.impactedEdges.length > 0) {
        lines.push("## Impacted Relationships");
        lines.push("");
        for (const edge of ctx.impactedEdges) {
            lines.push(`- ${edge.source} --[${edge.type}]--> ${edge.target}`);
        }
        lines.push("");
    }
    if (ctx.unmappedFiles.length > 0) {
        lines.push("## Unmapped Files");
        lines.push("");
        lines.push("These changed files are not yet in the knowledge graph:");
        lines.push("");
        for (const f of ctx.unmappedFiles) {
            lines.push(`- \`${f}\``);
        }
        lines.push("");
    }
    lines.push("## Risk Assessment");
    lines.push("");
    const complexChanges = ctx.changedNodes.filter((n) => n.complexity === "complex");
    const crossLayerCount = new Set(ctx.affectedLayers.map((l) => l.id)).size;
    if (complexChanges.length > 0) {
        lines.push(`- **High complexity**: ${complexChanges.length} complex component(s) changed: ${complexChanges.map((n) => n.name).join(", ")}`);
    }
    if (crossLayerCount > 1) {
        lines.push(`- **Cross-layer impact**: Changes span ${crossLayerCount} architectural layers`);
    }
    if (ctx.affectedNodes.length > 5) {
        lines.push(`- **Wide blast radius**: ${ctx.affectedNodes.length} components affected downstream`);
    }
    if (ctx.unmappedFiles.length > 0) {
        lines.push(`- **New/unmapped files**: ${ctx.unmappedFiles.length} files not in the knowledge graph (may need re-analysis)`);
    }
    if (complexChanges.length === 0 &&
        crossLayerCount <= 1 &&
        ctx.affectedNodes.length <= 5 &&
        ctx.unmappedFiles.length === 0) {
        lines.push("- **Low risk**: Changes are localized with limited downstream impact.");
    }
    lines.push("");
    return lines.join("\n");
}

/**
 * Build a context for explaining a specific file or function.
 * Supports file paths ("src/auth.ts") and path:function ("src/auth.ts:login").
 */
export function buildExplainContext(graph, path) {
    const { nodes, edges, layers } = graph;
    let targetNode = null;
    // Check for path:function format (e.g. "src/auth.ts:login")
    const colonIdx = path.lastIndexOf(":");
    if (colonIdx > 0 && !path.includes("://")) {
        const filePath = path.slice(0, colonIdx);
        const funcName = path.slice(colonIdx + 1);
        targetNode =
            nodes.find((n) => n.filePath === filePath && n.name === funcName) ?? null;
    }
    // Fall back to file path match
    if (!targetNode) {
        targetNode = nodes.find((n) => n.filePath === path) ?? null;
    }
    if (!targetNode) {
        return {
            projectName: graph.project.name,
            path,
            targetNode: null,
            childNodes: [],
            connectedNodes: [],
            relevantEdges: [],
            layer: null,
        };
    }
    // Find child nodes (contained by this node via "contains" edges)
    const childNodes = nodes.filter((n) => edges.some((e) => e.source === targetNode.id &&
        e.target === n.id &&
        e.type === "contains"));
    const allRelatedIds = new Set([
        targetNode.id,
        ...childNodes.map((n) => n.id),
    ]);
    // Find connected nodes (1-hop neighbors, excluding children and self)
    const connectedIds = new Set();
    const relevantEdges = [];
    for (const edge of edges) {
        if (allRelatedIds.has(edge.source) || allRelatedIds.has(edge.target)) {
            relevantEdges.push(edge);
            if (allRelatedIds.has(edge.source) && !allRelatedIds.has(edge.target)) {
                connectedIds.add(edge.target);
            }
            if (allRelatedIds.has(edge.target) && !allRelatedIds.has(edge.source)) {
                connectedIds.add(edge.source);
            }
        }
    }
    const connectedNodes = nodes.filter((n) => connectedIds.has(n.id));
    const layer = layers.find((l) => l.nodeIds.includes(targetNode.id)) ?? null;
    return {
        projectName: graph.project.name,
        path,
        targetNode,
        childNodes,
        connectedNodes,
        relevantEdges,
        layer,
    };
}
/**
 * Format the explain context as a structured prompt for LLM consumption.
 */
export function formatExplainPrompt(ctx) {
    if (!ctx.targetNode) {
        return [
            `# Component Not Found`,
            ``,
            `The path "${ctx.path}" was not found in the knowledge graph for ${ctx.projectName}.`,
            ``,
            `Possible reasons:`,
            `- The file hasn't been analyzed yet. Try running /understand first`,
            `- The path may be different in the graph. Check the exact file path`,
            `- The file may have been deleted or renamed since the last analysis`,
        ].join("\n");
    }
    const { targetNode, childNodes, connectedNodes, relevantEdges, layer } = ctx;
    const lines = [];
    lines.push(`# Deep Dive: ${targetNode.name}`);
    lines.push("");
    lines.push(`**Type:** ${targetNode.type} | **Complexity:** ${targetNode.complexity}`);
    if (targetNode.filePath)
        lines.push(`**File:** \`${targetNode.filePath}\``);
    if (targetNode.lineRange)
        lines.push(`**Lines:** ${targetNode.lineRange[0]}-${targetNode.lineRange[1]}`);
    lines.push("");
    lines.push(`**Summary:** ${targetNode.summary}`);
    lines.push("");
    if (layer) {
        lines.push(`## Architectural Layer: ${layer.name}`);
        lines.push(layer.description);
        lines.push("");
    }
    if (childNodes.length > 0) {
        lines.push("## Internal Components");
        for (const child of childNodes) {
            lines.push(`- **${child.name}** (${child.type}): ${child.summary}`);
        }
        lines.push("");
    }
    if (connectedNodes.length > 0) {
        lines.push("## Connected Components");
        for (const node of connectedNodes) {
            lines.push(`- **${node.name}** (${node.type}): ${node.summary}`);
        }
        lines.push("");
    }
    if (relevantEdges.length > 0) {
        const nodeMap = new Map([...[targetNode], ...childNodes, ...connectedNodes].map((n) => [
            n.id,
            n,
        ]));
        lines.push("## Relationships");
        for (const edge of relevantEdges) {
            if (edge.type === "contains")
                continue;
            const src = nodeMap.get(edge.source)?.name ?? edge.source;
            const tgt = nodeMap.get(edge.target)?.name ?? edge.target;
            const desc = edge.description ? `: ${edge.description}` : "";
            lines.push(`- ${src} --[${edge.type}]--> ${tgt}${desc}`);
        }
        lines.push("");
    }
    if (targetNode.languageNotes) {
        lines.push("## Language Notes");
        lines.push(targetNode.languageNotes);
        lines.push("");
    }
    lines.push("## Instructions");
    lines.push("Provide a thorough explanation of this component:");
    lines.push("1. What it does and why it exists in the project");
    lines.push("2. How data flows through it (inputs, processing, outputs)");
    lines.push("3. How it interacts with connected components");
    lines.push("4. Any patterns, idioms, or design decisions worth noting");
    lines.push("5. Potential gotchas or areas of complexity");
    lines.push("");
    return lines.join("\n");
}

/**
 * Generate a structured onboarding guide from the knowledge graph.
 * Output is standalone markdown suitable for a README, wiki, or docs.
 */
export function buildOnboardingGuide(graph) {
    const { project, nodes, edges, layers, tour } = graph;
    const lines = [];
    // --- Project Overview ---
    lines.push(`# ${project.name}`);
    lines.push("");
    lines.push(`> ${project.description}`);
    lines.push("");
    lines.push(`| | |`);
    lines.push(`|---|---|`);
    lines.push(`| **Languages** | ${project.languages.join(", ")} |`);
    lines.push(`| **Frameworks** | ${project.frameworks.join(", ")} |`);
    lines.push(`| **Components** | ${nodes.length} nodes, ${edges.length} relationships |`);
    lines.push(`| **Last Analyzed** | ${project.analyzedAt} |`);
    lines.push("");
    // --- Architecture ---
    if (layers.length > 0) {
        lines.push("## Architecture");
        lines.push("");
        lines.push("The project is organized into the following layers:");
        lines.push("");
        for (const layer of layers) {
            const memberNames = layer.nodeIds
                .map((id) => nodes.find((n) => n.id === id)?.name)
                .filter(Boolean);
            lines.push(`### ${layer.name}`);
            lines.push("");
            lines.push(layer.description);
            lines.push("");
            if (memberNames.length > 0) {
                lines.push(`Key components: ${memberNames.join(", ")}`);
                lines.push("");
            }
        }
    }
    // --- Key Concepts ---
    const conceptNodes = nodes.filter((n) => n.type === "concept");
    if (conceptNodes.length > 0) {
        lines.push("## Key Concepts");
        lines.push("");
        lines.push("Important architectural and domain concepts to understand:");
        lines.push("");
        for (const concept of conceptNodes) {
            lines.push(`### ${concept.name}`);
            lines.push("");
            lines.push(concept.summary);
            lines.push("");
        }
    }
    // --- Getting Started (Tour) ---
    if (tour.length > 0) {
        lines.push("## Getting Started");
        lines.push("");
        lines.push("Follow this guided tour to understand the codebase:");
        lines.push("");
        for (const step of tour) {
            const stepNodes = step.nodeIds
                .map((id) => nodes.find((n) => n.id === id))
                .filter(Boolean);
            lines.push(`### ${step.order}. ${step.title}`);
            lines.push("");
            lines.push(step.description);
            lines.push("");
            if (stepNodes.length > 0) {
                lines.push("**Files to look at:**");
                for (const node of stepNodes) {
                    if (node.filePath) {
                        lines.push(`- \`${node.filePath}\`: ${node.summary}`);
                    }
                }
                lines.push("");
            }
            if (step.languageLesson) {
                lines.push(`> **Language Tip:** ${step.languageLesson}`);
                lines.push("");
            }
        }
    }
    // --- File Map ---
    const fileNodes = nodes.filter((n) => n.type === "file" && n.filePath);
    if (fileNodes.length > 0) {
        lines.push("## File Map");
        lines.push("");
        lines.push("| File | Purpose | Complexity |");
        lines.push("|------|---------|------------|");
        for (const node of fileNodes) {
            lines.push(`| \`${node.filePath}\` | ${node.summary} | ${node.complexity} |`);
        }
        lines.push("");
    }
    // --- Complexity Hotspots ---
    const complexNodes = nodes.filter((n) => n.complexity === "complex");
    if (complexNodes.length > 0) {
        lines.push("## Complexity Hotspots");
        lines.push("");
        lines.push("These components are the most complex and deserve extra attention:");
        lines.push("");
        for (const node of complexNodes) {
            lines.push(`- **${node.name}** (${node.type}): ${node.summary}`);
        }
        lines.push("");
    }
    // --- Footer ---
    lines.push("---");
    lines.push("");
    lines.push(`*Generated by [Understand Anything](https://github.com/Egonex-AI/Understand-Anything) from knowledge graph v${graph.version}*`);
    lines.push("");
    return lines.join("\n");
}
