import { parseSignatureName } from "./SignatureParser.js";

// ─── Type-level signature parsing ─────────────────────────────────────────────

type TrimWS<S extends string> =
  S extends ` ${infer R}` ? TrimWS<R> :
  S extends `${infer L} ` ? TrimWS<L> :
  S;

/** Strip " : description" suffix from a token */
type TrimDesc<T extends string> =
  T extends `${infer Name} : ${string}` ? TrimWS<Name> : TrimWS<T>;

/** Extract every raw `{...}` token from a signature string */
type ExtractTokens<S extends string> =
  S extends `${string}{${infer Token}}${infer Rest}`
    ? Token | ExtractTokens<Rest>
    : never;

type ExtractOptionName<T extends string> =
  T extends `--${infer N}=${string}` ? TrimWS<N> :
  T extends `--${infer N}` ? TrimWS<N> :
  never;

type ExtractArgName<T extends string> =
  T extends `${infer N}?` ? TrimWS<N> :
  T extends `${infer N}*` ? TrimWS<N> :
  T extends `${infer N}=${string}` ? TrimWS<N> :
  TrimWS<T>;

type ClassifyToken<T extends string> =
  TrimDesc<T> extends infer C extends string
    ? C extends `-${string}`
      ? { kind: "option"; name: ExtractOptionName<C> }
      : { kind: "arg"; name: ExtractArgName<C> }
    : never;

/** Union of positional argument names extracted from a signature literal */
export type ArgNames<TSig extends string> =
  // Distribute over each token in the union so the conditional applies per-member
  ExtractTokens<TSig> extends infer T extends string
    ? ClassifyToken<T> extends { kind: "arg"; name: infer N extends string }
      ? N
      : never
    : never;

/** Union of option names extracted from a signature literal */
export type OptionNames<TSig extends string> =
  ExtractTokens<TSig> extends infer T extends string
    ? ClassifyToken<T> extends { kind: "option"; name: infer N extends string }
      ? N
      : never
    : never;

/** Arg parameter type: falls back to `string` when no names are inferable */
type ArgParam<TSig extends string> = [ArgNames<TSig>] extends [never] ? string : ArgNames<TSig>;

/** Option parameter type: falls back to `string` when no names are inferable */
type OptionParam<TSig extends string> = [OptionNames<TSig>] extends [never] ? string : OptionNames<TSig>;

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface CommandContext<TSig extends string = string> {
  argument(name: ArgParam<TSig>): string;
  argumentOptional(name: ArgParam<TSig>): string | undefined;
  argumentArray(name: ArgParam<TSig>): string[];
  option(name: OptionParam<TSig>): string | boolean | undefined;
  info(msg: string | object): void;
  warn(msg: string | object): void;
  error(msg: string | object): void;
  line(msg?: string | object): void;
}

export interface CommandDefinition<TSig extends string = string> {
  signature: TSig;
  description?: string;
  handle(ctx: CommandContext<TSig>): Promise<void>;
}

export type CommandConstructor<TSig extends string = string> =
  (new () => Command<TSig>) & { signature: string; description?: string };

export type CommandEntry = CommandConstructor<any> | CommandDefinition<any>;

// ─── Registry ──────────────────────────────────────────────────────────────────

const registry = new Map<string, CommandEntry>();

export function defineCommand<S extends string>(def: CommandDefinition<S>): CommandDefinition<S> {
  return def;
}

export function registerCommand(entry: CommandEntry): void {
  const name = parseSignatureName(entry.signature);
  registry.set(name, entry);
}

export function resolveCommand(name: string): CommandEntry | undefined {
  return registry.get(name);
}

export function listCommands(): CommandEntry[] {
  return [...registry.values()];
}

export function clearCommands(): void {
  registry.clear();
}

export function isCommandConstructor(entry: CommandEntry): entry is CommandConstructor<any> {
  return typeof entry === "function";
}

// ─── ANSI helpers ──────────────────────────────────────────────────────────────

const ANSI = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
};

function format(msg: string | object): string {
  return typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
}

// ─── Command base class ────────────────────────────────────────────────────────

export abstract class Command<TSig extends string = string> {
  static signature: string;
  static description?: string;

  _parsedArgs: Record<string, string | string[] | undefined> = {};
  _parsedOptions: Record<string, string | boolean | undefined> = {};

  argument(name: ArgParam<TSig>): string {
    const val = this._parsedArgs[name as string];
    if (val === undefined || val === null) {
      throw new Error(`Missing required argument: ${name as string}`);
    }
    return Array.isArray(val) ? (val[0] ?? "") : val;
  }

  argumentOptional(name: ArgParam<TSig>): string | undefined {
    const val = this._parsedArgs[name as string];
    if (val === undefined || val === null) return undefined;
    return Array.isArray(val) ? val[0] : val;
  }

  argumentArray(name: ArgParam<TSig>): string[] {
    const val = this._parsedArgs[name as string];
    if (!val) return [];
    return Array.isArray(val) ? val : [val];
  }

  option(name: OptionParam<TSig>): string | boolean | undefined {
    return this._parsedOptions[name as string];
  }

  info(msg: string | object): void  { console.log(ANSI.green(format(msg))); }
  warn(msg: string | object): void  { console.warn(ANSI.yellow(format(msg))); }
  error(msg: string | object): void { console.error(ANSI.red(format(msg))); }
  line(msg: string | object = ""): void { console.log(format(msg)); }

  abstract handle(): Promise<void>;

  /**
   * Factory for typed commands — mirrors `Model.define<T>()`.
   *
   * ```ts
   * class SendEmail extends Command.define("email:send {to} {--queue=default} {--force}") {
   *   async handle() {
   *     this.argument("to");      // ✅ autocompletes "to"
   *     this.option("queue");     // ✅ autocompletes "queue" | "force"
   *   }
   * }
   * ```
   */
  static define<S extends string>(signature: S) {
    abstract class TypedBase extends Command<S> {
      static signature = signature;
    }
    return TypedBase;
  }
}
