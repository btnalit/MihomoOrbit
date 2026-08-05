import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import type { StatsDatabase } from '../db/db.js';

/**
 * Drives POST /api/agent/heartbeat the way a real agent would: Bearer token
 * + the minimal payload the handler requires (protocolVersion is validated
 * by isAgentCompatible before agentId is even parsed).
 */
async function heartbeat(app: FastifyInstance, backendId: number, token: string, agentId: string) {
  return app.inject({
    method: 'POST',
    url: '/api/agent/heartbeat',
    headers: { authorization: `Bearer ${token}` },
    payload: { backendId, agentId, protocolVersion: 1 },
  });
}

describe('agent ingest auth by agent_token (M1c)', () => {
  let db: StatsDatabase;
  let cleanup: () => void;
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ db, cleanup } = createTestDatabase());
    app = await createApp({ port: 0, db, realtimeStore, logger: false, autoListen: false });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    cleanup();
  });

  // 迁移来的存量行:url 仍是 agent://,token 镜像仍在——上报必须继续工作
  it('accepts heartbeat for a migrated legacy agent row', async () => {
    const id = db.createBackend({
      name: 'legacy', url: 'agent://legacy', token: 'tok-legacy',
      apiUrl: '', apiSecret: '', agentToken: 'tok-legacy',
    });
    const res = await heartbeat(app, id, 'tok-legacy', 'agent-a');
    expect(res.statusCode).toBe(200);
  });

  // 统一模型新行:url 镜像是 http(s),旧的 url 前缀判据会 400——新判据必须放行
  it('accepts heartbeat when agent_token is set even though url mirror is http', async () => {
    const id = db.createBackend({
      name: 'unified', url: 'http://10.0.0.1:9090', token: 'tok-agent',
      apiUrl: 'http://10.0.0.1:9090', apiSecret: 's', agentToken: 'tok-agent',
    });
    const res = await heartbeat(app, id, 'tok-agent', 'agent-b');
    expect(res.statusCode).toBe(200);
  });

  it('rejects heartbeat for a backend without agent_token', async () => {
    const id = db.createBackend({
      name: 'direct', url: 'http://10.0.0.2:9090', token: 's',
      apiUrl: 'http://10.0.0.2:9090', apiSecret: 's',
    });
    const res = await heartbeat(app, id, 's', 'agent-c');
    expect(res.statusCode).toBe(400);
  });

  it('first valid heartbeat claims the binding and persists agent_id', async () => {
    const id = db.createBackend({ name: 'b', url: 'agent://b', token: 't1', agentToken: 't1' });
    await heartbeat(app, id, 't1', 'agent-first');
    expect(db.getBackend(id)!.agent_id).toBe('agent-first');
  });

  it('a different agent is rejected with 409 even after the old 10s window elapsed', async () => {
    const id = db.createBackend({ name: 'b2', url: 'agent://b2', token: 't2', agentToken: 't2' });
    await heartbeat(app, id, 't2', 'agent-owner');
    // 把心跳时间伪造成很久以前——旧逻辑会放行重绑,新逻辑必须仍 409
    db.upsertAgentHeartbeat({
      backendId: id, agentId: 'agent-owner',
      lastSeen: new Date(Date.now() - 3_600_000).toISOString(),
    } as never);
    const res = await heartbeat(app, id, 't2', 'agent-thief');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_BINDING_FIXED');
  });

  it('the bound agent itself is always allowed', async () => {
    const id = db.createBackend({ name: 'b3', url: 'agent://b3', token: 't3', agentToken: 't3' });
    await heartbeat(app, id, 't3', 'agent-same');
    const res = await heartbeat(app, id, 't3', 'agent-same');
    expect(res.statusCode).toBe(200);
  });
});
