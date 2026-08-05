import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createTestDatabase } from '../../__tests__/helpers.js';
import { AuthService } from '../auth/auth.service.js';
import { StatsService } from '../stats/index.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import { StatsWebSocketServer } from './websocket.server.js';
import type { StatsDatabase } from '../db/db.js';

// I2: the WS server must verify tokens through the SAME AuthService instance
// as the HTTP app (constructed once in index.ts and injected into both), so
// that updateToken()/enableAuth() cache invalidation reaches WS handshakes
// too. Before this fix, websocket.server.ts constructed its own independent
// `new AuthService(db)`, so a revoked token could keep opening new WS
// connections for up to that copy's own 5-minute verify cache TTL.

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.once('close', (code: number) => resolve({ code }));
    ws.once('error', () => {
      // A rejected handshake surfaces as an 'error' before 'close' on some
      // platforms; fall back to a generic non-1000 code so the assertion
      // below (code !== 1000) still distinguishes it from a clean open+close.
      ws.once('close', (code: number) => resolve({ code }));
    });
  });
}

describe('WebSocket server uses the shared AuthService instance', () => {
  let db: StatsDatabase;
  let cleanup: () => void;
  let authService: AuthService;
  let wsServer: StatsWebSocketServer;

  beforeEach(async () => {
    ({ db, cleanup } = createTestDatabase());
    authService = new AuthService(db);
    const statsService = new StatsService(db, realtimeStore);
    // Port 0: let the OS assign a free ephemeral port; getPort() reads back
    // the actual bound port once start() resolves.
    wsServer = new StatsWebSocketServer(0, db, statsService, authService);
    await wsServer.start();
  });

  afterEach(() => {
    wsServer.stop();
    cleanup();
  });

  it('accepts the current token, then rejects it immediately after updateToken() on the shared instance', async () => {
    await authService.enableAuth('a-16-char-token-1');
    const port = wsServer.getPort();

    const good = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Cookie: 'orbit-session=a-16-char-token-1' },
    });
    await waitForOpen(good);
    good.close();

    // Rotate the token on the shared AuthService — the WS server holds no
    // independent copy, so this must invalidate the old token for new
    // handshakes right away, not after some cache TTL.
    await authService.updateToken('b-16-char-token-2');

    const stale = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Cookie: 'orbit-session=a-16-char-token-1' },
    });
    const { code } = await waitForClose(stale);
    expect(code).toBe(4003);

    const fresh = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Cookie: 'orbit-session=b-16-char-token-2' },
    });
    await waitForOpen(fresh);
    fresh.close();
  });
});
