import { ModelPersistence } from "./ModelPersistence.js";
import type { ModelJson, DotPaths, DeepPick } from "./ModelBase.js";

function deepPick(obj: Record<string, any>, paths: string[]): Record<string, any> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const dot = path.indexOf(".");
    if (dot === -1) {
      if (!groups.has(path)) groups.set(path, []);
    } else {
      const root = path.slice(0, dot);
      const tail = path.slice(dot + 1);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(tail);
    }
  }
  const result: Record<string, any> = {};
  for (const [root, tails] of groups) {
    const val = obj[root];
    if (tails.length === 0) {
      result[root] = val;
    } else if (val === null || val === undefined) {
      result[root] = val;
    } else if (Array.isArray(val)) {
      result[root] = val.map(item => deepPick(item, tails));
    } else if (typeof val === "object") {
      result[root] = deepPick(val, tails);
    } else {
      result[root] = val;
    }
  }
  return result;
}

export class ModelSerialization<T extends Record<string, any> = any> extends ModelPersistence<T> {
  makeHidden(...keys: (string | string[])[]): this {
    const flat = keys.flat();
    this.$hidden = [...new Set([...this.$hidden, ...flat])];
    return this;
  }

  makeVisible(...keys: (string | string[])[]): this {
    const flat = keys.flat();
    this.$visible = [...new Set([...this.$visible, ...flat])];
    this.$hidden = this.$hidden.filter((k) => !flat.includes(k));
    return this;
  }

  append<K extends string>(...keys: (K | K[])[]): this & Record<K, any> {
    const flat = keys.flat();
    this.$appends = [...new Set([...this.$appends, ...flat])];
    return this as this & Record<K, any>;
  }

  setAppends<K extends string>(keys: K[]): this & Record<K, any> {
    this.$appends = [...keys];
    return this as this & Record<K, any>;
  }

  getAppends(): string[] {
    const constructor = this.getModelConstructor();
    return [...new Set([...(constructor.appends || []), ...this.$appends])];
  }

  private isVisible(key: string): boolean {
    const constructor = this.getModelConstructor();
    const visible = [...constructor.visible, ...this.$visible];
    if (visible.length > 0) return visible.includes(key);
    const hidden = new Set([...constructor.hidden, ...this.$hidden]);
    return !hidden.has(key);
  }

  private serialize(includeRelations: boolean = true): Record<string, any> {
    const result: Record<string, any> = {};
    for (const key of Object.keys(this.$attributes)) {
      if (this.isVisible(key)) result[key] = this.getAttribute(key);
    }
    for (const key of this.getAppends()) {
      if (!this.isVisible(key)) continue;
      result[key] = this.getAttribute(key as any);
    }
    if (includeRelations) {
      for (const key of Object.keys(this.$relations)) {
        if (!this.isVisible(key)) continue;
        const value = this.$relations[key];
        if (value === null || value === undefined) {
          result[key] = value;
        } else if (typeof value.toJSON === "function") {
          result[key] = value.toJSON();
        } else if (Array.isArray(value)) {
          result[key] = value.map((item: any) => typeof item?.toJSON === "function" ? item.toJSON() : item);
        } else {
          result[key] = value;
        }
      }
    }
    return result;
  }

  toJSON(): ModelJson<this> {
    return this.serialize(true) as ModelJson<this>;
  }

  json(): ModelJson<this>;
  json(options: { relations?: boolean }): ModelJson<this>;
  json<P extends DotPaths<ModelJson<this>>>(...paths: P[]): DeepPick<ModelJson<this>, P>;
  json<P extends DotPaths<ModelJson<this>>>(first?: { relations?: boolean } | P, ...rest: P[]): any {
    if (first !== undefined && typeof first === "object" && !Array.isArray(first)) {
      return this.serialize((first as { relations?: boolean }).relations !== false);
    }
    const paths = (first !== undefined ? [first as P, ...rest] : []) as string[];
    const full = this.serialize(true) as Record<string, any>;
    if (paths.length === 0) return full;
    return deepPick(full, paths);
  }

  toString(): string {
    return JSON.stringify(this.toJSON());
  }
}
