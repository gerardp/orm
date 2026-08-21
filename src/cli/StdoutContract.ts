/**
 * `--json` promises that stdout carries the command's JSON document and nothing
 * else. Keeping that promise takes more than routing the ORM's own progress
 * lines: a `console.log()` inside a migration's `up()`, a migration event
 * listener, `tenancy.listTenants()`, or the config module itself would land on
 * stdout and break `JSON.parse` for whoever is reading.
 *
 * So for the duration of such a command the console, process.stdout and Bun's
 * native stdout handle are relayed to stderr — relayed, not silenced: the
 * output still reaches a human, just not the channel that is under contract.
 * The payload itself is written with {@link writeToStdout}, which always reaches
 * the real stdout.
 *
 * ---------------------------------------------------------------------------
 * WORKAROUND(bun-console-stdout) — the console patching below, not the relay.
 *
 * Redirecting `process.stdout.write` would be enough on a runtime where the
 * console writes through that stream. Bun's console does not: every method
 * goes straight to the file descriptor, so each one that prints to stdout has
 * to be replaced by hand. Measured on Bun 1.4.0:
 *
 *   stdout   log info debug dir dirxml table count group groupCollapsed write
 *            and trace — which goes to stderr on Node, but not here
 *   stderr   error warn assert time timeLog timeEnd  (left alone)
 *   silent   countReset groupEnd  (forwarded: they carry state, not output)
 *
 * To check whether Bun still behaves this way:
 *
 *   bun -e 'process.stdout.write = (() => true) as any; console.log("leaked")'
 *
 * If that prints nothing, the console now goes through the stream: delete
 * STDOUT_CONSOLE_METHODS, `replacement()`, the `originals` map and the counter
 * bookkeeping, and keep the `process.stdout.write` / `Bun.stdout` swaps in
 * `install()` / `restore()`. The exported API and its callers do not change.
 * ---------------------------------------------------------------------------
 */

/** Console methods that reach stdout, plus the two that only carry state. */
const STDOUT_CONSOLE_METHODS = [
  "log",
  "info",
  "debug",
  "dir",
  "dirxml",
  "table",
  "count",
  "countReset",
  "group",
  "groupCollapsed",
  "groupEnd",
  "trace",
  "write",
] as const;

type StdoutConsoleMethod = (typeof STDOUT_CONSOLE_METHODS)[number];

/** Handles outstanding. The relay is installed on the first and undone on the last. */
let active = 0;
let originalStdoutWrite: typeof process.stdout.write | undefined;
let originalBunStdout: typeof Bun.stdout | undefined;
/** The exact functions taken off `console`, restored by identity. */
const originals = new Map<StdoutConsoleMethod, (...args: any[]) => any>();
/** `console.count()` bookkeeping, since the real counters cannot be read. */
const counters = new Map<string, number>();
let writeError: (...args: any[]) => void = console.error;

function callOriginal(method: StdoutConsoleMethod, ...args: any[]): any {
  return originals.get(method)?.apply(console, args);
}

function replacement(method: StdoutConsoleMethod): (...args: any[]) => any {
  switch (method) {
    case "table":
      return (data: any, properties?: any) =>
        writeError(typeof Bun !== "undefined" ? Bun.inspect.table(data, properties) : data);

    case "dir":
      return (item: any, options?: any) =>
        writeError(options && typeof Bun !== "undefined" ? Bun.inspect(item, options) : item);

    case "count":
      return (label: string = "default") => {
        const next = (counters.get(label) ?? 0) + 1;
        counters.set(label, next);
        writeError(`${label}: ${next}`);
      };

    // Prints nothing; forwarded so the real counter stays in step.
    case "countReset":
      return (label: string = "default") => {
        counters.delete(label);
        return callOriginal("countReset", label);
      };

    // The label is output, the indentation is state: relay one, forward the other.
    case "group":
    case "groupCollapsed":
      return (...args: any[]) => {
        if (args.length > 0) writeError(...args);
        return callOriginal(method);
      };

    case "groupEnd":
      return () => callOriginal("groupEnd");

    case "trace":
      return (...args: any[]) => {
        writeError("Trace:", ...args);
        const frames = (new Error().stack ?? "").split("\n").slice(2).join("\n");
        if (frames) writeError(frames);
      };

    // Bun-only, and the one console method that writes without a newline.
    case "write":
      return (...chunks: any[]) => {
        const text = chunks.map(String).join("");
        process.stderr.write(text);
        return text.length;
      };

    default:
      return (...args: any[]) => writeError(...args);
  }
}

function install(): void {
  writeError = console.error.bind(console);

  originalStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk: any, ...rest: any[]) =>
    (process.stderr.write as any)(chunk, ...rest)) as typeof process.stdout.write;
  if (typeof Bun !== "undefined") {
    originalBunStdout = Bun.stdout;
    // Bun.write(Bun.stdout, ...), Bun.stdout.write() and writer() bypass the
    // Node-compatible stream, so point the native stdout handle at stderr too.
    (Bun as any).stdout = Bun.stderr;
  }

  counters.clear();
  for (const method of STDOUT_CONSOLE_METHODS) {
    const original = (console as any)[method];
    if (typeof original !== "function") continue;
    originals.set(method, original);
    (console as any)[method] = replacement(method);
  }
}

function restore(): void {
  for (const [method, original] of originals) (console as any)[method] = original;
  originals.clear();
  counters.clear();
  if (originalStdoutWrite) process.stdout.write = originalStdoutWrite;
  originalStdoutWrite = undefined;
  if (originalBunStdout) (Bun as any).stdout = originalBunStdout;
  originalBunStdout = undefined;
}

/**
 * Relays stdout to stderr until the returned function is called.
 *
 * Nesting is safe and so is releasing out of order: the relay is torn down when
 * the last outstanding handle is released, whichever one that turns out to be.
 * Each handle is idempotent — releasing it twice does not free someone else's.
 */
export function relayStdoutToStderr(): () => void {
  if (active++ === 0) install();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--active === 0) restore();
  };
}

/** Writes to the real stdout, relay installed or not. */
export function writeToStdout(text: string): void {
  (originalStdoutWrite ?? process.stdout.write).call(process.stdout, text);
}
