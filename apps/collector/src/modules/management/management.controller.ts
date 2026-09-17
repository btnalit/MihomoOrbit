/**
 * Management Controller - Fastify routes for /api/management
 *
 * Shape follows backend.controller.ts: each route resolves the backend
 * first and short-circuits with resolve()'s own status/body on failure,
 * then maps any upstream error the service throws onto the unified
 * error shape from m1-contracts.md (404 backend-not-found / 409
 * NO_MANAGEMENT_CAPABILITY handled by resolve(); 502/504/500 handled here).
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ManagementService } from './management.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    managementService: ManagementService;
  }
}

interface BackendParams {
  backendId: string;
}

interface GroupParams extends BackendParams {
  name: string;
}

interface DelayParams extends BackendParams {
  proxy: string;
}

interface ConnectionParams extends BackendParams {
  connId: string;
}

interface ProviderRefreshParams extends BackendParams {
  kind: string;
  name: string;
}

interface SelectProxyBody {
  proxy: string;
}

interface DelayQuery {
  url?: string;
  timeout?: string;
}

interface DelayGroupBody {
  url?: string;
  timeout?: number;
}

type PatchConfigsBody = Record<string, unknown>;

// Mirrors management.service.ts's own clampDelayTimeout — belt-and-suspenders
// so a caller that reaches the service directly (bypassing this parse) is
// still protected.
const MIN_DELAY_TIMEOUT_MS = 100;
const MAX_DELAY_TIMEOUT_MS = 30_000;

/** Query/body timeout values arrive as untyped user input — a garbage,
 *  negative, or non-finite value must not reach AbortSignal.timeout, which
 *  throws a RangeError/TypeError that the generic catch below would
 *  misclassify as a 502 unreachable error. NaN/non-finite/zero/negative
 *  values are treated as "not specified" (undefined) so the service's own
 *  default (5000ms) applies; anything else is clamped into
 *  [MIN_DELAY_TIMEOUT_MS, MAX_DELAY_TIMEOUT_MS]. */
function parseOptionalTimeout(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(MAX_DELAY_TIMEOUT_MS, Math.max(MIN_DELAY_TIMEOUT_MS, n));
}

/** `err.status` is set by two different throw sites, distinguishable only by
 *  whether `body` also came along: `upstreamFetch` (management.service.ts)
 *  sets `{ status }` alone for a genuine upstream non-2xx response;
 *  `requireResolved` sets `{ status, body }` together for its own 404/409
 *  resolve() short-circuit (backend deleted between the controller's resolve
 *  check and the service call actually reaching it). Only the former is a
 *  real "upstream answered with an error" case — the latter must keep
 *  falling through to the 500 default exactly as before this fix, not get
 *  relabeled as a reachable upstream 4xx. */
function mapUpstreamError(err: unknown, backendId: number): { status: number; body: Record<string, unknown> } {
  const e = err as { message?: string; timeout?: boolean; reachable?: boolean; status?: number; body?: unknown };

  if (e.timeout) {
    return { status: 504, body: { error: e.message ?? 'Unknown error', backendId, reachable: false } };
  }
  if (e.reachable === false) {
    return { status: 502, body: { error: e.message ?? 'Unknown error', backendId, reachable: false } };
  }
  if (typeof e.status === 'number' && e.body === undefined) {
    if (e.status === 401 || e.status === 403) {
      return {
        status: 502,
        body: {
          code: 'UPSTREAM_UNAUTHORIZED',
          backendId,
          reachable: true,
          upstreamStatus: e.status,
          error: 'Upstream rejected credentials',
        },
      };
    }
    return {
      status: 502,
      body: { backendId, reachable: true, upstreamStatus: e.status, error: e.message ?? 'Unknown error' },
    };
  }
  return { status: 500, body: { error: e.message ?? 'Unknown error', backendId, reachable: false } };
}

/**
 * M4 core-ops precondition (plan §2): the core's lifecycle may have at most
 * one concurrent changer. The M2b editor's six-step config write-back
 * (dispatch -> agent write -> reload -> triple health gate) polls
 * `getInFlight` itself and would misread a manual restart/reload landing
 * mid-flight as an external failure and roll the edit back. restartCore and
 * reloadConfig therefore check the same in-flight config command here,
 * before calling upstream at all, and refuse with 409 CORE_BUSY if one
 * exists — mirroring config-editor.controller.ts's own
 * CONFIG_COMMAND_IN_FLIGHT precondition check against the same repository.
 * The two cache flushes don't touch config state and are not gated by this.
 */
function checkCoreNotBusy(fastify: FastifyInstance, backendId: number): { busy: false } | { busy: true; commandId: string } {
  const inFlight = fastify.db.configCommands.getInFlight(backendId, Date.now());
  if (!inFlight) return { busy: false };
  return { busy: true, commandId: inFlight.command_id };
}

const managementController: FastifyPluginAsync = async (fastify: FastifyInstance): Promise<void> => {
  const service = fastify.managementService;

  fastify.get<{ Params: BackendParams }>('/:backendId/groups', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    try {
      return await service.fetchGroups(backendId);
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  fastify.put<{ Params: GroupParams; Body: SelectProxyBody }>('/:backendId/groups/:name', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    try {
      await service.selectProxy(backendId, request.params.name, request.body.proxy);
      return { success: true };
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  fastify.get<{ Params: DelayParams; Querystring: DelayQuery }>('/:backendId/delay/:proxy', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    try {
      return await service.testDelay(backendId, request.params.proxy, {
        url: request.query.url,
        timeout: parseOptionalTimeout(request.query.timeout),
      });
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  fastify.post<{ Params: GroupParams; Body: DelayGroupBody }>('/:backendId/delay-group/:name', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    try {
      const result = await service.startGroupDelayTest(backendId, request.params.name, {
        url: request.body?.url,
        timeout: parseOptionalTimeout(request.body?.timeout),
      });
      if (!result.accepted) {
        return reply.status(409).send({ code: result.code });
      }
      return reply.status(202).send(result);
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  fastify.delete<{ Params: ConnectionParams }>('/:backendId/connections/:connId', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    try {
      await service.killConnection(backendId, request.params.connId);
      return { success: true };
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  fastify.get<{ Params: BackendParams }>('/:backendId/configs', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    try {
      return await service.getConfigs(backendId);
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  fastify.patch<{ Params: BackendParams; Body: PatchConfigsBody }>('/:backendId/configs', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    try {
      await service.patchConfigs(backendId, request.body);
      return { success: true };
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  // M1.5: providers management page (plan 2026-08-22-m1_5-providers-and-groups-polish.md).
  fastify.get<{ Params: BackendParams }>('/:backendId/providers', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    try {
      return await service.fetchProviders(backendId);
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  fastify.post<{ Params: ProviderRefreshParams }>('/:backendId/providers/:kind/:name/refresh', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    const { kind } = request.params;
    if (kind !== 'rule' && kind !== 'proxy') {
      return reply.status(400).send({ error: 'Invalid provider kind — expected "rule" or "proxy"' });
    }

    try {
      await service.refreshProvider(backendId, kind, request.params.name);
      return { success: true };
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  // M4 core-ops (plan 2026-09-16-m4-core-ops.md): runtime settings page
  // additions — restart core / reload config / flush DNS cache / flush
  // Fake-IP cache. All four sit behind the same resolve() capability gate as
  // every other management route; restart and reload additionally check
  // checkCoreNotBusy above (§2's single-writer invariant) before touching
  // upstream at all.
  fastify.post<{ Params: BackendParams }>('/:backendId/core/restart', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    const busy = checkCoreNotBusy(fastify, backendId);
    if (busy.busy) {
      return reply.status(409).send({ code: 'CORE_BUSY', backendId, commandId: busy.commandId });
    }

    try {
      // Audit line (plan §2: "collector 对 restart/reload 记 info 日志" — no
      // new table, this log line is the record). Emitted only once the
      // request has cleared both gates and is actually about to reach
      // upstream, not on a 404/409/busy short-circuit above.
      // console, not request.log: the Fastify logger is off in production
      // (app.ts `logger: false`), so request.log.* is a no-op there — the
      // audit line would silently never land. `[Module] ...` on console is
      // the collector's operational-log idiom (see BackendService).
      console.log(`[Management] core.restart requested for backend ${backendId}`);
      return await service.restartCore(backendId);
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  fastify.post<{ Params: BackendParams }>('/:backendId/core/reload', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    const busy = checkCoreNotBusy(fastify, backendId);
    if (busy.busy) {
      return reply.status(409).send({ code: 'CORE_BUSY', backendId, commandId: busy.commandId });
    }

    try {
      console.log(`[Management] core.reload requested for backend ${backendId}`); // see restart's comment
      await service.reloadConfig(backendId);
      return { success: true };
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  fastify.post<{ Params: BackendParams }>('/:backendId/cache/dns/flush', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    try {
      await service.flushDnsCache(backendId);
      return { success: true };
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });

  fastify.post<{ Params: BackendParams }>('/:backendId/cache/fakeip/flush', async (request, reply) => {
    const backendId = Number(request.params.backendId);
    const r = service.resolve(backendId);
    if (!r.ok) return reply.status(r.status).send(r.body);

    try {
      await service.flushFakeipCache(backendId);
      return { success: true };
    } catch (err) {
      const { status, body } = mapUpstreamError(err, backendId);
      return reply.status(status).send(body);
    }
  });
};

export default managementController;
