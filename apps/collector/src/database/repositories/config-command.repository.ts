/**
 * Config Command Repository (M2b)
 *
 * State machine for editor-submitted config apply/rollback commands.
 * pending -> dispatched -> applied|conflict|rolled-back|failed.
 *
 * 'failed' is an adjudicated extension beyond the spec's three receipt
 * outcomes, for pre-write agent failures (unreadable disk, unsupported
 * gateway) that are semantically neither conflict nor rolled-back.
 *
 * TTL (COMMAND_TTL_MS) is a read-time concept only — "expired" is never
 * stored as a state. getInFlight() computes it against a caller-supplied
 * nowMs (never SQLite's own clock) so callers/tests can simulate elapsed
 * time without depending on wall-clock delays. A late receipt (resolve()
 * arriving after the TTL window) is still accepted as long as the command
 * is still in a non-terminal (pending/dispatched) state in storage.
 */
import type Database from 'better-sqlite3';

export const COMMAND_TTL_MS = 10 * 60 * 1000;

export type CommandState = 'pending' | 'dispatched' | 'applied' | 'conflict' | 'rolled-back' | 'failed';

export interface ConfigCommand {
  command_id: string;
  backend_id: number;
  version_id: number;
  base_hash: string;
  payload: string;
  state: CommandState;
  reason: string;
  created_at: string;
  dispatched_at: string | null;
  resolved_at: string | null;
}

const SELECT_COLUMNS = `
  command_id, backend_id, version_id, base_hash, payload, state, reason,
  created_at, dispatched_at, resolved_at
`;

const IN_FLIGHT_STATES = ['pending', 'dispatched'] as const;

/**
 * Format a millisecond epoch timestamp the same way SQLite's
 * CURRENT_TIMESTAMP does ('YYYY-MM-DD HH:MM:SS', UTC, second precision) so
 * a TEXT comparison against the stored created_at column is chronologically
 * correct.
 */
function toSqliteUtcDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export class ConfigCommandRepository {
  constructor(private db: Database.Database) {}

  create(cmd: {
    commandId: string;
    backendId: number;
    versionId: number;
    baseHash: string;
    payload: string;
  }): void {
    this.db.prepare(`
      INSERT INTO config_commands (command_id, backend_id, version_id, base_hash, payload, state, reason)
      VALUES (?, ?, ?, ?, ?, 'pending', '')
    `).run(cmd.commandId, cmd.backendId, cmd.versionId, cmd.baseHash, cmd.payload);
  }

  /**
   * Non-terminal (pending|dispatched) command for the backend that has not
   * exceeded the TTL window as of nowMs. At most one such command should
   * exist per backend by construction (callers check this before create()).
   */
  getInFlight(backendId: number, nowMs: number): ConfigCommand | undefined {
    const cutoff = toSqliteUtcDatetime(nowMs - COMMAND_TTL_MS);
    return this.db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM config_commands
      WHERE backend_id = ?
        AND state IN (${IN_FLIGHT_STATES.map(() => '?').join(', ')})
        AND created_at >= ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(backendId, ...IN_FLIGHT_STATES, cutoff) as ConfigCommand | undefined;
  }

  /**
   * Heartbeat-driven dispatch marker. Idempotent: only the pending ->
   * dispatched transition writes dispatched_at; a command already in
   * 'dispatched' (or any other state) is left untouched so dispatched_at
   * keeps its first-set value and repeated heartbeats don't regress state.
   */
  markDispatched(commandId: string, nowIso: string): void {
    this.db.prepare(`
      UPDATE config_commands
      SET state = 'dispatched', dispatched_at = ?
      WHERE command_id = ? AND state = 'pending'
    `).run(nowIso, commandId);
  }

  /**
   * Agent command-result receipt. Accepted from any non-terminal state
   * (including one that has aged past the TTL — expired is a read-time
   * concept, not stored, so late receipts still land). Idempotent:
   * repeated receipts for an already-terminal command are no-ops and
   * return null (first receipt wins).
   *
   * SCOPED by `backendId` (M2b final-review minor fix): a receipt is only
   * ever accepted for a command that belongs to the SAME backend the
   * heartbeat authenticated as — defense in depth against a compromised or
   * buggy agent for backend A submitting a `commandResults` entry carrying
   * a commandId that actually belongs to backend B (commandId is already
   * effectively unguessable, 32 random hex chars, but this closes the class
   * regardless of that).
   *
   * Returns the resolved row (post-update) on success — not just a boolean
   * — so callers get `version_id` and the new `state` from the SAME atomic
   * update, with no separate lookup race. Returns null if nothing matched
   * (unknown commandId, wrong backendId, or already-terminal).
   */
  resolve(
    commandId: string,
    backendId: number,
    result: 'applied' | 'conflict' | 'rolled-back' | 'failed',
    reason: string,
    nowIso: string,
  ): ConfigCommand | null {
    const res = this.db.prepare(`
      UPDATE config_commands
      SET state = ?, reason = ?, resolved_at = ?
      WHERE command_id = ? AND backend_id = ? AND state IN (${IN_FLIGHT_STATES.map(() => '?').join(', ')})
    `).run(result, reason, nowIso, commandId, backendId, ...IN_FLIGHT_STATES);
    if (res.changes === 0) return null;
    return this.db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM config_commands
      WHERE command_id = ?
    `).get(commandId) as ConfigCommand;
  }

  /**
   * Most recent command for a backend regardless of state, for the
   * commands/latest read endpoint. created_at is second-granularity, so
   * ties (including expired-window backfills used in tests) are broken by
   * rowid — config_commands has no monotonic integer id column, but SQLite
   * still maintains an implicit rowid in insertion order.
   */
  getLatest(backendId: number): ConfigCommand | undefined {
    return this.db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM config_commands
      WHERE backend_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(backendId) as ConfigCommand | undefined;
  }

  /**
   * Read-time "expired" computation for the commands/latest endpoint
   * (M2b Task 6). A command is expired iff it is still non-terminal
   * (pending/dispatched) AND its age exceeds COMMAND_TTL_MS as of nowMs —
   * terminal states (applied/conflict/rolled-back/failed) are never
   * expired, matching getInFlight's IN_FLIGHT_STATES filter exactly.
   *
   * Deliberately mirrors getInFlight's own technique — compute a cutoff
   * SQLite-UTC-datetime string from nowMs via toSqliteUtcDatetime, then
   * compare it against the stored created_at STRING (lexicographic
   * comparison on 'YYYY-MM-DD HH:MM:SS' is chronologically correct) —
   * rather than parsing created_at into a Date. See Task 4's binding
   * ledger note (progress.md): created_at is a SQLite space-separated,
   * no-'Z' UTC string; `new Date(created_at)` outside the repository
   * depends on the runtime's local timezone for the missing offset and
   * silently mis-parses. This is the exact negation of getInFlight's own
   * `created_at >= cutoff` check, so the two can never disagree on the
   * boundary.
   */
  isExpired(cmd: Pick<ConfigCommand, 'state' | 'created_at'>, nowMs: number): boolean {
    if (cmd.state !== 'pending' && cmd.state !== 'dispatched') return false;
    const cutoff = toSqliteUtcDatetime(nowMs - COMMAND_TTL_MS);
    return cmd.created_at < cutoff;
  }
}
