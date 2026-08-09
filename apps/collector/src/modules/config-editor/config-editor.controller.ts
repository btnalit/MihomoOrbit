/**
 * Config Editor Controller — Fastify routes for /api/config-editor (M2a:
 * read-only surface. M2b adds the apply/write path.)
 *
 * Deliberately thin (per the M2a plan): no separate service class — this
 * combines the config_versions repository (fastify.db.configVersions,
 * Task 4) with yaml-mask.ts directly. The capability gate mirrors
 * management.service.ts's resolve() shape (backend-not-found → 404 first,
 * then the capability check → 409), but gates on the `configEdit`
 * capability (`agent_id !== ''`) instead of `management`'s `api_url`, with
 * NO_CONFIG_EDIT_CAPABILITY as the 409 code (plan §契约速查).
 *
 * Registered behind the app's mandatory-auth hooks like every other
 * /api/* route (NOT added to PUBLIC_ROUTES) — unlike the agent ingest
 * endpoints, this is an admin-facing read surface.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { maskYamlSecrets } from './yaml-mask.js';

interface BackendParams {
  backendId: string;
}

type CapabilityResult =
  | { ok: true }
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
  return { ok: true };
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
};

export default configEditorController;
