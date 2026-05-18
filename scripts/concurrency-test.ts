// Ad-hoc load harness. Not part of the test suite.
// Usage: bun scripts/concurrency-test.ts [url] [cookie] [levels]
const url = process.argv[2] || "https://demo.localhost/admissions";
const cookie = process.argv[3] || process.env.SIMS_SESSION || "";
const levels = (process.argv[4] || "10,25,50,100,200,400,800,1200")
  .split(",")
  .map((n) => parseInt(n.trim(), 10))
  .filter((n) => n > 0);

const headers: Record<string, string> = {};
if (cookie) headers["cookie"] = cookie.includes("=") ? cookie : `sims_session=${cookie}`;

// localhost demo almost certainly self-signed.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function once(): Promise<{ ms: number; status: number; err?: string }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers, redirect: "manual" });
    // Drain body so the connection is fully released.
    await res.arrayBuffer();
    return { ms: performance.now() - t0, status: res.status };
  } catch (e: any) {
    return { ms: performance.now() - t0, status: 0, err: e?.message || String(e) };
  }
}

async function level(concurrency: number) {
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: concurrency }, once));
  const wall = performance.now() - t0;

  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const byStatus = new Map<number, number>();
  const errs = new Map<string, number>();
  for (const r of results) {
    byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
    if (r.err) errs.set(r.err, (errs.get(r.err) || 0) + 1);
  }

  const ok = (byStatus.get(200) || 0) + (byStatus.get(302) || 0) + (byStatus.get(304) || 0);
  console.log(
    `\n── concurrency ${concurrency} ───────────────────────────────`
  );
  console.log(`wall ${wall.toFixed(0)}ms  throughput ${(concurrency / (wall / 1000)).toFixed(1)} req/s`);
  console.log(
    `latency  p50 ${pct(lat, 50).toFixed(0)}  p95 ${pct(lat, 95).toFixed(0)}  max ${pct(lat, 100).toFixed(0)} ms`
  );
  console.log(`ok ${ok}/${concurrency}  status ` + JSON.stringify(Object.fromEntries(byStatus)));
  if (errs.size) console.log(`errors ` + JSON.stringify(Object.fromEntries(errs)));
}

console.log(`target ${url}`);
console.log(`cookie ${cookie ? "set" : "MISSING"}`);

// Warmup single request — surfaces auth/TLS/routing problems before load.
const warm = await once();
console.log(`warmup status ${warm.status} ${warm.ms.toFixed(0)}ms ${warm.err ? "ERR " + warm.err : ""}`);
if (warm.status === 0) {
  console.log("warmup failed — aborting load (fix connectivity/cert/host first).");
  process.exit(1);
}

for (const c of levels) {
  await level(c);
}
