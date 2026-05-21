import { readdir } from "fs/promises";
import { existsSync } from "fs";
import { extname, join, resolve, sep } from "path";
import { pathToFileURL } from "url";
import { normalizePathList } from "../../utils.js";
import type { BunnyConfig } from "../../config/BunnyConfig.js";
import type { ModelConstructor } from "../../model/Model.js";
import type { SearchableModelConstructor } from "../Searchable.js";

async function walkModelFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkModelFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.endsWith(".d.ts") || name.endsWith(".test.ts") || name.endsWith(".spec.ts")) continue;
    if (![".ts", ".js", ".mts", ".mjs"].includes(extname(name))) continue;
    out.push(full);
  }
  return out;
}

function modelPathRoots(config: BunnyConfig): string[] {
  const mp = config.modelsPath;
  if (!mp) return [];
  if (typeof mp === "string" || Array.isArray(mp)) return normalizePathList(mp);
  const combined: string[] = [];
  if (mp.landlord) combined.push(...normalizePathList(mp.landlord));
  if (mp.tenant) combined.push(...normalizePathList(mp.tenant));
  return combined;
}

export async function loadSearchableModels(config: BunnyConfig): Promise<SearchableModelConstructor[]> {
  const roots = modelPathRoots(config);
  const loaded = new Map<string, SearchableModelConstructor>();
  for (const root of roots) {
    const abs = resolve(process.cwd(), root);
    if (!existsSync(abs)) continue;
    const files = await walkModelFiles(abs);
    for (const file of files) {
      const mod = await import(pathToFileURL(file).href);
      for (const exported of Object.values(mod)) {
        if (typeof exported !== "function") continue;
        const ctor = exported as unknown as SearchableModelConstructor & ModelConstructor;
        if (ctor.searchable === true && typeof ctor.searchableAs === "function") {
          loaded.set(ctor.name, ctor);
        }
      }
    }
  }
  return [...loaded.values()];
}

export async function resolveSearchableModel(
  config: BunnyConfig,
  name: string,
): Promise<SearchableModelConstructor | undefined> {
  const all = await loadSearchableModels(config);
  return all.find((m) => m.name === name);
}
