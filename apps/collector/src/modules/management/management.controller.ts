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

/** Query/body timeout values arrive as untyped user input — a garbage value
 *  must not reach AbortSignal.timeout(NaN), which throws a TypeError that
 *  the generic catch below would misclassify as a 502 unreachable error. */
function parseOptionalTimeout(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
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
};

export default managementController;
