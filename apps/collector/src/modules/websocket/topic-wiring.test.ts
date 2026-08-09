import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createTestDatabase, createTestBackend } from '../../__tests__/helpers.js';
import { AuthService } from '../auth/auth.service.js';
import { StatsService } from '../stats/index.js';
import { realtimeStore } from '../realtime/realtime.store.js';
import { StatsWebSocketServer } from './websocket.server.js';
import type { StatsDatabase } from '../db/db.js';

// M1 final-review fix wave, finding 6: websocket.server.ts's topic-subscribe
// wiring (validation, hook ordering) and TopicHub fan-out had zero direct
// coverage — everything exercising them went through higher-level relay/
// controller tests. Same live-server harness as websocket-auth.test.ts: a
// real StatsWebSocketServer on port 0, real `ws` clients, auth enabled the
// same way (enableAuth + orbit-session cookie) since the connection handler
// rejects unauthenticated sockets with 4001 before any message is parsed.
//
// This is an in-process test: client and server share ONE event loop over a
// loopback socket. The server's stats path runs several synchronous
// better-sqlite3 queries inside an `async` wrapper, which can block the
// event loop long enough that the server finishes `ws.send()`-ing the
// unsolicited initial stats push before the CLIENT side has even processed
// the handshake response and fired its own 'open' event. A 'message'
// listener attached only AFTER awaiting 'open' can therefore miss that
// first frame outright — so every client here gets a persistent frame
// buffer attached at WebSocket construction time, before 'open' is even
// possible, and assertions poll that buffer instead of racing a one-shot
// listener against frames that already arrived.

const AUTH_TOKEN = 'a-16-char-token-1';

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

interface Frame {
  type: string;
  topic?: string;
  backendId?: number;
  [key: string]: unknown;
}

interface ClientHandle {
  ws: WebSocket;
  frames: Frame[];
}

/** Polls `handle.frames` (already-arrived or arriving later — order doesn't
 *  matter, only that it's captured) for the first frame matching `predicate`. */
async function waitForFrame(
  handle: ClientHandle,
  predicate: (frame: Frame) => boolean,
  timeoutMs = 3000,
): Promise<Frame> {
  await vi.waitFor(() => expect(handle.frames.some(predicate)).toBe(true), { timeout: timeoutMs });
  return handle.frames.find(predicate)!;
}

describe('StatsWebSocketServer topic-subscribe wiring', () => {
  let db: StatsDatabase;
  let cleanup: () => void;
  let authService: AuthService;
  let wsServer: StatsWebSocketServer;
  let sockets: WebSocket[];

  beforeEach(async () => {
    ({ db, cleanup } = createTestDatabase());
    authService = new AuthService(db);
    await authService.enableAuth(AUTH_TOKEN);
    // Pre-warm AuthService's positive verification cache: a token's FIRST
    // verifyToken() call runs a real scrypt hash check (deliberately slow),
    // which would otherwise widen the same kind of race described above.
    // Every actual per-client verifyToken() call below then hits the cache.
    await authService.verifyToken(AUTH_TOKEN);
    const statsService = new StatsService(db, realtimeStore);
    wsServer = new StatsWebSocketServer(0, db, statsService, authService);
    await wsServer.start();
    sockets = [];
  });

  afterEach(() => {
    for (const ws of sockets) ws.terminate();
    wsServer.stop();
    cleanup();
  });

  async function connectClient(): Promise<ClientHandle> {
    const port = wsServer.getPort();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Cookie: `orbit-session=${AUTH_TOKEN}` },
    });
    sockets.push(ws);
    const frames: Frame[] = [];
    // Attached synchronously at construction, before 'open' is even
    // possible — see the file header for why this matters here.
    ws.on('message', (data) => {
      try {
        frames.push(JSON.parse(data.toString()));
      } catch {
        // Not JSON — ignore.
      }
    });
    await waitForOpen(ws);
    return { ws, frames };
  }

  it('(a) topic-subscribe to a valid backend registers exactly one subscriber', async () => {
    const backendId = createTestBackend(db, 'wiring-a');
    const client = await connectClient();

    client.ws.send(JSON.stringify({ type: 'topic-subscribe', topic: 'connections', backendId }));

    await vi.waitFor(() =>
      expect(wsServer.getTopicHub().subscriberCount('connections', backendId)).toBe(1),
    );

    // Also observable end-to-end: a publish on that exact topic+backendId
    // reaches this client.
    wsServer.getTopicHub().publishSnapshot(
      'connections',
      backendId,
      JSON.stringify({ type: 'topic', topic: 'connections', backendId, data: {}, timestamp: new Date().toISOString() }),
    );
    const frame = await waitForFrame(client, (f) => f.type === 'topic' && f.topic === 'connections');
    expect(frame).toMatchObject({ type: 'topic', topic: 'connections', backendId });
  });

  it('(b) an invalid topic name yields a topic-error with reachable:false', async () => {
    const backendId = createTestBackend(db, 'wiring-b');
    const client = await connectClient();

    client.ws.send(JSON.stringify({ type: 'topic-subscribe', topic: 'not-a-real-topic', backendId }));

    const frame = await waitForFrame(client, (f) => f.type === 'topic-error');
    expect(frame).toMatchObject({ type: 'topic-error', reachable: false });
    expect(typeof frame.error).toBe('string');
  });

  it('(c) an unknown backendId yields a topic-error', async () => {
    // Just a fixture so the DB has SOME backend (irrelevant to what's under
    // test) — the actual assertion below deliberately uses a different,
    // nonexistent id.
    createTestBackend(db, 'wiring-c-fixture');
    const client = await connectClient();

    client.ws.send(JSON.stringify({ type: 'topic-subscribe', topic: 'connections', backendId: 999999 }));

    const frame = await waitForFrame(client, (f) => f.type === 'topic-error');
    expect(frame).toMatchObject({ type: 'topic-error', reachable: false });
    expect(typeof frame.error).toBe('string');

    // Confirms it never reached TopicHub.subscribe (belt-and-suspenders on
    // the "unknown backend" branch specifically, distinct from (b)'s
    // "unknown topic" branch).
    expect(wsServer.getTopicHub().subscriberCount('connections', 999999)).toBe(0);
  });

  it('(d) subscribe stats:false suppresses stats broadcasts for that client only', async () => {
    const backendId = createTestBackend(db, 'wiring-d');
    db.setActiveBackend(backendId);

    const quiet = await connectClient();
    const control = await connectClient();

    quiet.ws.send(JSON.stringify({ type: 'subscribe', stats: false, backendId }));
    // A second message on the SAME connection, right after — 'ws' delivers
    // a single connection's frames strictly in receipt order, so confirming
    // THIS one was applied also confirms the stats:false subscribe ahead of
    // it already landed. Without this, broadcastStats() below could race
    // ahead of quiet's own (separate-connection, no ordering guarantee
    // relative to control's) subscribe actually being processed.
    quiet.ws.send(JSON.stringify({ type: 'topic-subscribe', topic: 'connections', backendId }));
    await vi.waitFor(() => expect(wsServer.getTopicHub().subscriberCount('connections', backendId)).toBe(1));

    control.ws.send(JSON.stringify({ type: 'subscribe', backendId }));

    // Control's own subscribe (a real backendId change) triggers an
    // immediate stats push in addition to the connection-time initial one.
    await vi.waitFor(() => expect(control.frames.filter((f) => f.type === 'stats').length).toBeGreaterThanOrEqual(1));

    const quietStatsBefore = quiet.frames.filter((f) => f.type === 'stats').length;
    const controlStatsBefore = control.frames.filter((f) => f.type === 'stats').length;

    wsServer.broadcastStats(backendId, true);

    await vi.waitFor(() =>
      expect(control.frames.filter((f) => f.type === 'stats').length).toBeGreaterThan(controlStatsBefore),
    );
    // Give the quiet client's socket the same window to (wrongly) receive one.
    await new Promise((r) => setTimeout(r, 200));
    expect(quiet.frames.filter((f) => f.type === 'stats').length).toBe(quietStatsBefore);
  });

  it('(e) a subscriberJoinedHook fired during topic-subscribe always precedes a publishAppend sent right after', async () => {
    const backendId = createTestBackend(db, 'wiring-e');
    const hub = wsServer.getTopicHub();

    // Stands in for Task 3's ManagementRelay#onSubscriberJoined (log-history
    // replay): sends a marker frame via hub.sendTo synchronously inside the
    // same topic-subscribe handling call stack.
    wsServer.setSubscriberJoinedHook((ws, topic, id) => {
      if (topic === 'logs' && id === backendId) {
        hub.sendTo(
          ws,
          JSON.stringify({ type: 'topic', topic: 'logs', backendId, data: { marker: true }, timestamp: new Date().toISOString() }),
        );
      }
    });

    const client = await connectClient();

    client.ws.send(JSON.stringify({ type: 'topic-subscribe', topic: 'logs', backendId }));
    // subscriberCount flips synchronously within the same server-side
    // message handler that also invokes subscriberJoinedHook — by the time
    // this resolves, the marker's ws.send() has already been issued.
    await vi.waitFor(() => expect(hub.subscriberCount('logs', backendId)).toBe(1));

    hub.publishAppend(
      'logs',
      backendId,
      JSON.stringify({ type: 'topic', topic: 'logs', backendId, data: { seq: 1 }, timestamp: new Date().toISOString() }),
    );

    await vi.waitFor(() =>
      expect(client.frames.filter((f) => f.topic === 'logs').length).toBeGreaterThanOrEqual(2),
    );
    const logFrames = client.frames.filter((f) => f.topic === 'logs');
    expect(logFrames[0]!.data).toMatchObject({ marker: true });
    expect(logFrames[1]!.data).toMatchObject({ seq: 1 });
  });
});
