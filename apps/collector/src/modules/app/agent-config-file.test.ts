import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { createApp } from './app.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import type { StatsDatabase } from '../db/db.js';

/**
 * Assembles the contract payload for POST /api/agent/config-file (see the
 * plan's 契约速查 section): backendId/agentId/protocolVersion + a
 * configFile object carrying the sha256 hash, raw content, size and mtime.
 */
function payloadFor(backendId: number, content: string, agentId = 'agent-x') {
  const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  return {
    backendId,
    agentId,
    protocolVersion: 1,
    configFile: {
      path: '/etc/mihomo/config.yaml',
      hash,
      content,
      size: Buffer.byteLength(content, 'utf8'),
      modTimeMs: 1722840000000,
    },
  };
}

describe('POST /api/agent/config-file', () => {
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

  function mkAgentBackend(token: string): number {
    return db.createBackend({ name: `b-${token}`, url: `agent://${token}`, token, agentToken: token });
  }

  async function post(backendId: number, token: string, content: string) {
    return app.inject({
      method: 'POST',
      url: '/api/agent/config-file',
      headers: { authorization: `Bearer ${token}` },
      payload: payloadFor(backendId, content),
    });
  }

  it('is public-route exempt from admin auth but requires a valid agent token', async () => {
    const id = db.createBackend({ name: 'b', url: 'agent://b', token: 't1', agentToken: 't1' });
    const noTok = await app.inject({
      method: 'POST',
      url: '/api/agent/config-file',
      payload: payloadFor(id, 'port: 7890\n'),
    });
    expect(noTok.statusCode).toBe(401);

    const ok = await post(id, 't1', 'port: 7890\n');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ success: true, stored: true });
  });

  it('dedups by hash: same content stores once', async () => {
    const id = mkAgentBackend('t2');
    await post(id, 't2', 'port: 7890\n');
    const again = await post(id, 't2', 'port: 7890\n');
    expect(again.json().stored).toBe(false);
    expect(db.configVersions.listMeta(id)).toHaveLength(1);
  });

  it('keeps only the latest 20 versions per backend', async () => {
    const id = mkAgentBackend('t3');
    for (let i = 0; i < 25; i++) await post(id, 't3', `port: ${7000 + i}\n`);
    const metas = db.configVersions.listMeta(id);
    expect(metas).toHaveLength(20);
    // Survivors are the latest 20 (port 7005..7024)
    expect(db.configVersions.getLatest(id)!.content).toContain('7024');
  });

  it('rejects oversized content with 413', async () => {
    const id = mkAgentBackend('t4');
    const res = await post(id, 't4', 'a'.repeat(256 * 1024 + 1));
    expect(res.statusCode).toBe(413);
  });

  it('deleteBackendData removes its config versions', async () => {
    const id = mkAgentBackend('t5');
    await post(id, 't5', 'port: 1\n');
    db.deleteBackendData(id);
    expect(db.configVersions.listMeta(id)).toHaveLength(0);
  });

  it('rejects a CJK payload under 256K chars but over 256K bytes with 413', async () => {
    // Pins Buffer.byteLength(content, 'utf8') over content.length: each of these
    // CJK characters is 3 bytes in UTF-8 but counts as 1 toward .length, so a
    // string safely under the 256K *character* cap can still exceed the byte cap.
    const id = mkAgentBackend('t4b');
    const content = '中'.repeat(100_000); // 100,000 chars, 300,000 bytes
    expect(content.length).toBeLessThan(256 * 1024);
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(256 * 1024);
    const res = await post(id, 't4b', content);
    expect(res.statusCode).toBe(413);
  });

  it('rejects an oversized payload with 413 even when its hash is tampered (M3: size check runs before hash recompute)', async () => {
    // If the hash recompute ran first, a mismatched hash on oversized
    // content would surface as 400 HASH_MISMATCH — masking the fact that
    // the request was going to be rejected as too-large regardless, and
    // burning a full sha256 pass over up-to-256K+ bytes for nothing.
    const id = mkAgentBackend('t10');
    const payload = payloadFor(id, 'a'.repeat(256 * 1024 + 1));
    payload.configFile.hash = 'a'.repeat(64); // wrong sha256
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/config-file',
      headers: { authorization: 'Bearer t10' },
      payload,
    });
    expect(res.statusCode).toBe(413);
    expect(db.configVersions.listMeta(id)).toHaveLength(0);
  });

  it('stores size derived from the actual content bytes, ignoring a lying configFile.size (M4)', async () => {
    const id = mkAgentBackend('t11');
    const content = 'port: 7890\nmode: rule\n';
    const payload = payloadFor(id, content);
    payload.configFile.size = 999999; // lying claim, must not be trusted
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/config-file',
      headers: { authorization: 'Bearer t11' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const stored = db.configVersions.getLatest(id);
    expect(stored?.size).toBe(Buffer.byteLength(content, 'utf8'));
    expect(stored?.size).not.toBe(999999);
  });

  it('caps a stored filePath at 512 chars (M4)', async () => {
    const id = mkAgentBackend('t12');
    const longPath = '/etc/mihomo/' + 'a'.repeat(600) + '.yaml';
    const payload = payloadFor(id, 'port: 7890\n');
    payload.configFile.path = longPath;
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/config-file',
      headers: { authorization: 'Bearer t12' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const stored = db.configVersions.getLatest(id);
    expect(stored?.file_path.length).toBe(512);
    expect(longPath.startsWith(stored!.file_path)).toBe(true);
  });

  it('recomputes the hash server-side: a tampered hash is rejected and nothing is stored', async () => {
    const id = mkAgentBackend('t7');
    const payload = payloadFor(id, 'port: 7890\n');
    payload.configFile.hash = 'a'.repeat(64); // wrong sha256
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/config-file',
      headers: { authorization: 'Bearer t7' },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HASH_MISMATCH');
    expect(db.configVersions.listMeta(id)).toHaveLength(0);
  });

  it('accepts a correct-hash payload (control case for the tampered-hash test)', async () => {
    const id = mkAgentBackend('t7b');
    const res = await post(id, 't7b', 'port: 7890\n');
    expect(res.statusCode).toBe(200);
    expect(res.json().stored).toBe(true);
  });

  it('the bound agent is always allowed to report config files', async () => {
    const id = mkAgentBackend('t8');
    await post(id, 't8', 'port: 1\n');
    const res = await post(id, 't8', 'port: 2\n'); // same default agentId 'agent-x'
    expect(res.statusCode).toBe(200);
    expect(db.configVersions.listMeta(id)).toHaveLength(2);
  });

  it('a different agentId sharing the same token is rejected with 409', async () => {
    const id = mkAgentBackend('t9');
    await app.inject({
      method: 'POST',
      url: '/api/agent/config-file',
      headers: { authorization: 'Bearer t9' },
      payload: payloadFor(id, 'port: 1\n', 'agent-owner'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/config-file',
      headers: { authorization: 'Bearer t9' },
      payload: payloadFor(id, 'port: 2\n', 'agent-thief'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_BINDING_FIXED');
    expect(db.configVersions.listMeta(id)).toHaveLength(1);
  });

  it('an error-shape payload is acknowledged but not stored', async () => {
    const id = mkAgentBackend('t6');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/config-file',
      headers: { authorization: 'Bearer t6' },
      payload: {
        backendId: id,
        agentId: 'agent-x',
        protocolVersion: 1,
        configFile: { path: '/etc/mihomo/config.yaml', error: 'too-large' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, backendId: id, stored: false });
    expect(db.configVersions.listMeta(id)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
