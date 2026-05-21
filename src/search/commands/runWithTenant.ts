import { TenantContext } from "../../connection/TenantContext.js";

/**
 * Wraps a CLI handler's body in `TenantContext.run()` when a tenant id is
 * provided. Used by every per-model search command so `--tenant=<id>` works
 * uniformly across `search:import`, `search:flush`, etc.
 */
export async function runWithTenant<T>(
  tenantId: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!tenantId) return work();
  return TenantContext.run(tenantId, work);
}
