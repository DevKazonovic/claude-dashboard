import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_ROOT = join(homedir(), ".claude", "understand");

export function findDataDir(projectRoot) {
  let names;
  try {
    names = readdirSync(DATA_ROOT);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const info = JSON.parse(readFileSync(join(DATA_ROOT, name, "project.json"), "utf8"));
      if (info.projectRoot === projectRoot) return join(DATA_ROOT, name);
    } catch {}
  }
  return null;
}
