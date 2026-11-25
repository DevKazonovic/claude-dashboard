export const vueConfig = {
    id: "vue",
    displayName: "Vue",
    extensions: [".vue"],
    treeSitter: {
        wasmPackage: "tree-sitter-typescript",
        wasmFile: "tree-sitter-typescript.wasm",
    },
    concepts: [
        "single-file components",
        "script setup",
        "composition API",
        "options API",
        "reactivity (ref, reactive, computed)",
        "props and emits",
        "composables",
        "slots",
        "directives",
        "lifecycle hooks",
    ],
    filePatterns: {
        entryPoints: ["src/App.vue", "app.vue", "app/app.vue"],
        barrels: [],
        tests: [],
        config: ["vite.config.ts", "nuxt.config.ts", "vue.config.js"],
    },
};
