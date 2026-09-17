/**
 * Process-local "core restart in progress" registry (M4 core-ops).
 *
 * The plan's §2 invariant — one core-lifecycle mutator per backend at a
 * time — needs enforcing in BOTH directions. The config-command table only
 * covers one: management refuses restart/reload while an agent write-back
 * is in flight. The reverse (a config apply/rollback dispatched while a
 * manual restart is still polling `/version`) has nothing durable to key
 * off, because a restart writes no row. So the restart window is marked
 * here, in memory: it is bounded (≤15s poll cap), owned entirely by this
 * process, and worthless after a collector restart — exactly the profile
 * where a table would be over-engineering.
 *
 * Kept as a plain module (not a fastify decorator) so the management
 * service can mark it without any plugin ordering concern and the
 * config-editor controller can read it without importing management.
 */

const restarting = new Set<number>();

export function markCoreRestarting(backendId: number): void {
  restarting.add(backendId);
}

export function clearCoreRestarting(backendId: number): void {
  restarting.delete(backendId);
}

export function isCoreRestarting(backendId: number): boolean {
  return restarting.has(backendId);
}
