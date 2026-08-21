/**
 * Config file byte-size cap (M2b final-review fix, I1).
 *
 * Shared between the agent's config-file INGEST endpoint (app.ts's POST
 * /api/agent/config-file, the pre-existing cap) and the editor's WRITE
 * endpoints (apply/rollback, via config-editor.controller.ts's
 * enqueueCommand) — a single ceiling on how large a config.yaml is allowed
 * to be, enforced at every point content enters config_versions. Before
 * this fix, only the ingest side was capped: a user could submit editor
 * content past this size with no collector-side rejection, producing a
 * command payload the agent would then also reject client-side (its own
 * config-file report path caps at the same size), silently expiring after
 * the command TTL with no actionable error surfaced to the editor.
 */
export const CONFIG_FILE_MAX_BYTES = 256 * 1024;
