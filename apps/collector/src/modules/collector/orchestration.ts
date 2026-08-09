/**
 * Pure predicates for the collector's backend-orchestration loop (index.ts).
 * Extracted so the milestone's core invariant — a backend with an agent
 * token is never given a direct collector, even if it also has an api_url
 * (dual-channel) — is unit-testable without booting the whole process.
 *
 * Per the M1c semantic contract, `hasAgent(b) := b.agent_token !== ''` is the
 * traffic-source predicate: when present, traffic arrives via agent report,
 * so the collector must not also pull the same gateway directly (double
 * write). These two functions are the only place index.ts should ask that
 * question.
 */

/** True when this backend's traffic is sourced from an agent (agent_token set). */
export function isAgentSourced(b: { agent_token: string }): boolean {
  return b.agent_token !== '';
}

/**
 * True when index.ts's `startCollector` should actually connect to the
 * gateway directly: not agent-sourced, and an API URL is configured.
 * Agent-sourced backends never qualify, regardless of api_url.
 */
export function shouldStartDirectCollector(b: { agent_token: string; api_url: string }): boolean {
  return !isAgentSourced(b) && b.api_url.trim() !== '';
}
