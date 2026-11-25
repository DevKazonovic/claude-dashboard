const FIGMA_API = "https://api.figma.com/v1";
export function parseFileKey(urlOrKey) {
    const m = urlOrKey.match(/figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/);
    if (m)
        return m[1];
    if (/^[A-Za-z0-9]+$/.test(urlOrKey.trim()))
        return urlOrKey.trim();
    throw new Error(`Could not parse a Figma file key from: ${urlOrKey}`);
}
export class FigmaApiSource {
    fileKey;
    token;
    constructor(fileKey, token = process.env.FIGMA_TOKEN) {
        this.fileKey = fileKey;
        if (!token) {
            throw new Error("FIGMA_TOKEN is not set. Create a personal access token at " +
                "https://www.figma.com/settings, then run: export FIGMA_TOKEN=<token>");
        }
        this.token = token;
    }
    async get(path) {
        // Token travels only in the header — never in the URL, never logged.
        const res = await fetch(`${FIGMA_API}${path}`, { headers: { "X-Figma-Token": this.token } });
        if (!res.ok) {
            throw new Error(`Figma API ${path} failed: ${res.status} ${res.statusText}`);
        }
        return (await res.json());
    }
    fetchDocument() {
        return this.get(`/files/${this.fileKey}`);
    }
    fetchStyles() {
        return this.get(`/files/${this.fileKey}/styles`);
    }
    async renderImages(nodeIds) {
        if (nodeIds.length === 0)
            return {};
        const ids = encodeURIComponent(nodeIds.join(","));
        const data = await this.get(`/images/${this.fileKey}?ids=${ids}&format=png&scale=1`);
        return data.images ?? {};
    }
}
