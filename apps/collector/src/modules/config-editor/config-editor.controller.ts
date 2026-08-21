/**
 * Config Editor Controller — Fastify routes for /api/config-editor
 * (M2a: read-only surface. M2b adds the apply/rollback/commands/reveal
 * write path below.)
 *
 * Deliberately thin (per the M2a plan): no separate service class — this
 * combines the config_versions/config_commands repositories
 * (fastify.db.configVersions / fastify.db.configCommands, Tasks 4/5) with
 * yaml-mask.ts and apply-pipeline.ts directly. The capability gate mirrors
 * management.service.ts's resolve() shape (backend-not-found → 404 first,
 * then the capability check → 409), but gates on the `configEdit`
 * capability (`agent_id !== ''`) instead of `management`'s `api_url`, with
 * NO_CONFIG_EDIT_CAPABILITY as the 409 code (plan §契约速查).
 *
 * Registered behind the app's mandatory-auth hooks like every other
 * /api/* route (NOT added to PUBLIC_ROUTES) — unlike the agent ingest
 * endpoints, this is an admin-facing surface (read AND write: apply/
 * rollback/reveal are all admin actions, never agent-authenticated).
 *
 * M2b staleness baseline: `latest = fastify.db.configVersions.getLatest()`
 * is used SOURCE-AGNOSTICALLY as both the self-lock/sentinel comparison
 * base and the staleness ("latest agent-reported hash") comparison target,
 * for two reasons. (1) It is exactly the row M2a's GET /:backendId/current
 * already returns to the web client as `hash` — the value the client will
 * echo straight back as `baseHash` on its next apply — so comparing against
 * the SAME row that produced it is coherent by construction. (2) A
 * source='agent-report'-filtered query would be actively wrong: after a
 * successful apply, the agent re-reports the now-identical on-disk content,
 * and config_versions.insertIfChanged() dedupes that report against the
 * current latest row by hash (no new row is inserted) — so "the latest
 * agent-reported row" would permanently keep pointing at the PRE-apply
 * hash, deadlocking every subsequent apply with a spurious BASE_HASH_STALE.
 *
 * RESIDUAL CLOSED (M2b whole-branch final review, C2 — CRITICAL): the
 * conflict-loop residual documented here through Task 6 (a `conflict`/
 * `rolled-back`/`failed` receipt left the un-applied editor content as
 * "latest" indefinitely, deadlocking every subsequent apply with a
 * spurious BASE_HASH_STALE for up to the agent's next unrelated
 * config-file report, ~1h) is fixed at the heartbeat receipt handler
 * (app.ts's POST /api/agent/heartbeat, commandResults ingestion loop): a
 * non-applied receipt now deletes that command's own config_versions row
 * when it is still the backend's latest — see
 * ConfigVersionRepository.deleteIfLatestEditorVersion's doc comment for
 * the full guard rationale. `latest` here reverts to whatever the agent
 * actually has on disk immediately, not eventually.
 */

import { randomBytes, createHash } from 'crypto';
import { load } from 'js-yaml';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { maskYamlSecrets } from './yaml-mask.js';
import { prepareApply, type ApplyPrepared, type ApplyRejection } from './apply-pipeline.js';
import { CONFIG_FILE_MAX_BYTES } from './limits.js';
import type { ConfigVersion } from '../../database/repositories/config-version.repository.js';

interface BackendParams {
  backendId: string;
}

type BackendRow = NonNullable<ReturnType<FastifyInstance['db']['getBackend']>>;

type CapabilityResult =
  | { ok: true; backend: BackendRow }
  | { ok: false; status: 404; body: Record<string, unknown> }
  | { ok: false; status: 409; body: Record<string, unknown> };

/** Backend-not-found (404) takes priority over the capability check (409) —
 *  matches management.service.ts's resolve() ordering exactly. */
function resolveConfigEditCapability(fastify: FastifyInstance, backendId: number): CapabilityResult {
  const backend = fastify.db.getBackend(backendId);
  if (!backend) {
    return { ok: false, status: 404, body: { error: 'Backend not found' } };
  }
  if (!backend.agent_id) {
    return {
      ok: false,
      status: 409,
      body: { code: 'NO_CONFIG_EDIT_CAPABILITY', backendId, error: 'Backend has no bound agent' },
    };
  }
  return { ok: true, backend };
}

/** Maps a pipeline rejection (Task 5) onto its literal HTTP status + body
 *  per the plan's 写侧 API contract — every field name/status here is
 *  contract, not incidental. */
function sendApplyRejection(reply: FastifyReply, rejection: ApplyRejection) {
  switch (rejection.code) {
    case 'YAML_INVALID':
      return reply.status(422).send({ code: 'YAML_INVALID', detail: rejection.detail });
    case 'MASK_PATH_MISSING':
      return reply.status(422).send({ code: 'MASK_PATH_MISSING', path: rejection.path });
    case 'SELF_LOCK_FIELD_CHANGED':
      return reply.status(422).send({ code: 'SELF_LOCK_FIELD_CHANGED', field: rejection.field });
    case 'BASE_HASH_STALE':
      return reply.status(409).send({ code: 'BASE_HASH_STALE' });
  }
}

/**
 * Builds the config_versions row + config_commands envelope for a
 * successfully-prepared apply/rollback and enqueues it. Shared by both
 * write endpoints below — they differ only in how `prepared` was produced
 * (submitted content vs. a historical version's content), not in what
 * happens once the pipeline has accepted it.
 *
 * `latest` is the SAME row prepareApply validated staleness against (see
 * the module docstring) — its `hash` becomes both the command envelope's
 * `baseHash` (what the agent compares its on-disk sha256 against before
 * writing — plan §agent 六步, step ①) and the config_commands.base_hash
 * column, and its `file_path` carries forward into the new config_versions
 * row purely as continuity metadata (the agent's write target comes from
 * its own local config, never from this payload).
 *
 * I1 fix (M2b final-review): rejects with `contentTooLarge: true` when
 * `prepared.finalContent` — what actually gets stored/dispatched, not the
 * raw submitted body (resubstitution can only ever grow content, never
 * shrink it, so checking the FINAL content is the conservative choice) —
 * exceeds CONFIG_FILE_MAX_BYTES, the SAME cap the agent's own config-file
 * ingest endpoint enforces (app.ts). Before this fix there was no
 * collector-side cap on the write path at all: an oversized apply/rollback
 * would enqueue a command the agent could only reject client-side (its own
 * ingest cap), silently expiring after the command TTL with nothing
 * actionable surfaced back to the editor. Checked here (shared by both
 * apply and rollback, since both funnel through this one function) rather
 * than duplicated at each call site.
 */
function enqueueCommand(
  fastify: FastifyInstance,
  backendId: number,
  latest: ConfigVersion,
  prepared: ApplyPrepared,
): { ok: true; commandId: string; versionId: number } | { ok: false; contentTooLarge: true } {
  if (Buffer.byteLength(prepared.finalContent, 'utf8') > CONFIG_FILE_MAX_BYTES) {
    return { ok: false, contentTooLarge: true };
  }

  const finalHash = createHash('sha256').update(prepared.finalContent, 'utf8').digest('hex');
  const { id: versionId } = fastify.db.configVersions.insertIfChanged({
    backendId,
    hash: finalHash,
    content: prepared.finalContent,
    size: Buffer.byteLength(prepared.finalContent, 'utf8'),
    source: 'editor',
    filePath: latest.file_path,
  });

  const commandId = `cmd_${randomBytes(16).toString('hex')}`;
  const envelope = {
    commandId,
    type: 'apply-config' as const,
    baseHash: latest.hash,
    content: prepared.finalContent,
    verify: prepared.verify,
    issuedAtMs: Date.now(),
  };

  fastify.db.configCommands.create({
    commandId,
    backendId,
    versionId,
    baseHash: latest.hash,
    payload: JSON.stringify(envelope),
  });

  return { ok: true, commandId, versionId };
}

/**
 * Tokenizes a maskYamlSecrets()-style dotted/bracketed path
 * ("proxy-providers.sub.url", "proxies[2].password") and resolves it
 * against a freshly js-yaml-parsed document. Only ever called AFTER the
 * caller has confirmed the exact same path string is a member of that
 * document's OWN maskedPaths (yaml-mask.ts's traversal, which produced the
 * path string in the first place) — so this function is a convenience
 * re-walk of an already-known-valid location, not an independent source of
 * authorization.
 *
 * Documented residual (pre-existing, see yaml-mask.ts's PROVIDERS_KEYS
 * comment): a `.`-joined path is structurally ambiguous whenever a real key
 * contains a literal `.` or `[`/`]` (e.g. a proxy-provider named
 * `sub.example`) — in principle this tokenizer could then resolve a
 * DIFFERENT location than the one maskedPaths meant. Not fixed here: the
 * membership check against maskedPaths (not this resolver) is reveal's
 * actual security boundary, and building a structural resolver is out of
 * Task 6's scope.
 */
function resolveValueAtPath(content: string, path: string): { found: boolean; value?: unknown } {
  let node: unknown;
  try {
    node = load(content);
  } catch {
    return { found: false };
  }

  const tokens = path.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('[')) {
      const index = Number(token.slice(1, -1));
      if (!Array.isArray(node) || !Number.isInteger(index) || index < 0 || index >= node.length) {
        return { found: false };
      }
      node = node[index];
    } else {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) {
        return { found: false };
      }
      if (!Object.prototype.hasOwnProperty.call(node, token)) {
        return { found: false };
      }
      node = (node as Record<string, unknown>)[token];
    }
  }
  return { found: true, value: node };
}

const configEditorController: FastifyPluginAsync = async (fastify: FastifyInstance): Promise<void> => {
  fastify.get<{ Params: BackendParams }>('/:backendId/current', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = resolveConfigEditCapability(fastify, backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    const latest = fastify.db.configVersions.getLatest(backendId);
    if (!latest) {
      return reply.status(404).send({ code: 'NO_CONFIG_REPORTED', backendId });
    }

    const { maskedContent, maskedPaths, parseError } = maskYamlSecrets(latest.content);
    // parseError is additive beyond the plan's literal /current response
    // shape (which lists only maskedContent/maskedPaths) — included so a
    // client can distinguish "empty config" from "stored content no longer
    // parses as YAML, do not offer editing" instead of silently losing that
    // signal. See task-5-report.md.
    return {
      versionId: latest.id,
      hash: latest.hash,
      size: latest.size,
      filePath: latest.file_path,
      createdAt: latest.created_at,
      maskedContent,
      maskedPaths,
      parseError,
    };
  });

  fastify.get<{ Params: BackendParams }>('/:backendId/versions', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = resolveConfigEditCapability(fastify, backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    const versions = fastify.db.configVersions.listMeta(backendId).map((v) => ({
      versionId: v.id,
      hash: v.hash,
      size: v.size,
      source: v.source,
      createdAt: v.created_at,
    }));
    return { versions };
  });

  // --- M2b write path -------------------------------------------------

  fastify.post<{ Params: BackendParams; Body: { content?: string; baseHash?: string } }>(
    '/:backendId/apply',
    async (request, reply) => {
      const backendId = Number(request.params.backendId);
      const r = resolveConfigEditCapability(fastify, backendId);
      if (!r.ok) return reply.status(r.status).send(r.body);

      if (r.backend.type !== 'clash') {
        return reply.status(422).send({ code: 'UNSUPPORTED_GATEWAY' });
      }

      const latest = fastify.db.configVersions.getLatest(backendId);
      if (!latest) {
        return reply.status(404).send({ code: 'NO_CONFIG_REPORTED', backendId });
      }

      const inFlight = fastify.db.configCommands.getInFlight(backendId, Date.now());
      if (inFlight) {
        return reply.status(409).send({ code: 'CONFIG_COMMAND_IN_FLIGHT', commandId: inFlight.command_id });
      }

      const body = request.body || {};
      const content = typeof body.content === 'string' ? body.content : '';
      const baseHash = typeof body.baseHash === 'string' ? body.baseHash : '';

      const result = prepareApply({ backendId, content, baseHash }, latest.content, latest.hash);
      if (!result.ok) {
        return sendApplyRejection(reply, result.rejection);
      }

      const enqueued = enqueueCommand(fastify, backendId, latest, result.prepared);
      if (!enqueued.ok) {
        return reply.status(422).send({ code: 'CONTENT_TOO_LARGE' });
      }
      return reply.status(202).send({ commandId: enqueued.commandId, versionId: enqueued.versionId });
    },
  );

  fastify.post<{ Params: BackendParams & { versionId: string } }>(
    '/:backendId/rollback/:versionId',
    async (request, reply) => {
      const backendId = Number(request.params.backendId);
      const r = resolveConfigEditCapability(fastify, backendId);
      if (!r.ok) return reply.status(r.status).send(r.body);

      if (r.backend.type !== 'clash') {
        return reply.status(422).send({ code: 'UNSUPPORTED_GATEWAY' });
      }

      const latest = fastify.db.configVersions.getLatest(backendId);
      if (!latest) {
        return reply.status(404).send({ code: 'NO_CONFIG_REPORTED', backendId });
      }

      const versionId = Number(request.params.versionId);
      const target = fastify.db.configVersions.getById(backendId, versionId);
      if (!target) {
        return reply.status(404).send({ code: 'VERSION_NOT_FOUND', versionId });
      }

      const inFlight = fastify.db.configCommands.getInFlight(backendId, Date.now());
      if (inFlight) {
        return reply.status(409).send({ code: 'CONFIG_COMMAND_IN_FLIGHT', commandId: inFlight.command_id });
      }

      // baseHash is derived server-side (the current latest hash), never
      // taken from the client — a rollback request carries no body per the
      // plan's contract. This makes the staleness check trivially pass by
      // construction (input.baseHash === latestAgentHash === latest.hash),
      // while the self-lock compare below still runs for real against the
      // CURRENT latest content, so rolling back to a version whose
      // self-lock fields differ from what's on disk now is still rejected.
      const result = prepareApply(
        { backendId, content: target.content, baseHash: latest.hash },
        latest.content,
        latest.hash,
      );
      if (!result.ok) {
        return sendApplyRejection(reply, result.rejection);
      }

      const enqueued = enqueueCommand(fastify, backendId, latest, result.prepared);
      if (!enqueued.ok) {
        return reply.status(422).send({ code: 'CONTENT_TOO_LARGE' });
      }
      return reply.status(202).send({ commandId: enqueued.commandId, versionId: enqueued.versionId });
    },
  );

  fastify.get<{ Params: BackendParams }>('/:backendId/commands/latest', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = resolveConfigEditCapability(fastify, backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    const cmd = fastify.db.configCommands.getLatest(backendId);
    if (!cmd) {
      return { command: null };
    }

    return {
      command: {
        commandId: cmd.command_id,
        state: cmd.state,
        reason: cmd.reason,
        createdAt: cmd.created_at,
        dispatchedAt: cmd.dispatched_at,
        resolvedAt: cmd.resolved_at,
        expired: fastify.db.configCommands.isExpired(cmd, Date.now()),
      },
    };
  });

  fastify.post<{ Params: BackendParams; Body: { path?: string } }>('/:backendId/reveal', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = resolveConfigEditCapability(fastify, backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    const latest = fastify.db.configVersions.getLatest(backendId);
    if (!latest) {
      return reply.status(404).send({ code: 'NO_CONFIG_REPORTED', backendId });
    }

    const path = typeof request.body?.path === 'string' ? request.body.path : '';
    const { maskedPaths } = maskYamlSecrets(latest.content);
    if (!path || !maskedPaths.includes(path)) {
      return reply.status(404).send({ code: 'PATH_NOT_MASKED', path });
    }

    const resolved = resolveValueAtPath(latest.content, path);
    if (!resolved.found) {
      // Unreachable in practice — path is a member of maskedPaths, which
      // was computed from this exact content — but fail closed rather than
      // trust it blindly.
      return reply.status(404).send({ code: 'PATH_NOT_MASKED', path });
    }

    // AUDIT: every successful reveal is logged BEFORE the value leaves the
    // process — this is config_versions.content's first plaintext-secret
    // egress point out of the datastore (M2a→M2b handoff note in
    // progress.md: "reveal 端点是数据离库第一口——审计日志必须先行").
    console.info('[AUDIT] config-reveal', { ip: request.ip, backendId, path, at: new Date().toISOString() });

    return { value: resolved.value };
  });
};

export default configEditorController;
