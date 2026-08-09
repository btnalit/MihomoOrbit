import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { ManagementRelay } from './ws-relay.js';
import type { TopicHub } from '../websocket/topic-hub.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import type { StatsDatabase } from '../db/db.js';

// --- Fake Mihomo upstream: routes /connections vs /logs by req.url, same
// shape as gateway.collector.test.ts's fake server. `verifyClient` (HTTP-
// layer rejection, before the WS handshake completes) is what backs
// `refuseConnections` — rejecting there means the client's `open` event
// never fires, so a refused attempt is unambiguously a failure. ---
interface FakeUpstream {
  wss: WebSocketServer;
  port: number;
  refuseConnections: boolean;
  connectionCount: number;
  openCount: number;
  // Every handshake attempt, accepted or rejected — unlike connectionCount
  // (which only counts accepted ones), this lets a test count how many
  // real reconnect attempts actually happened while refuseConnections was
  // on, independent of the ws server's own 'connection' event.
  attemptCount: number;
  connectionSockets: import('ws').WebSocket[];
  logSockets: import('ws').WebSocket[];
  sendConnectionsSnapshot(data: unknown): void;
  pushLogs(n: number): void;
  close(): Promise<void>;
}

function createFakeUpstream(): Promise<FakeUpstream> {
  return new Promise((resolve) => {
    const state = {
      refuseConnections: false,
      connectionCount: 0,
      openCount: 0,
      attemptCount: 0,
      connectionSockets: [] as import('ws').WebSocket[],
      logSockets: [] as import('ws').WebSocket[],
    };

    const wss = new WebSocketServer({
      port: 0,
      verifyClient: (_info, callback) => {
        state.attemptCount += 1;
        callback(!state.refuseConnections);
      },
    });

    wss.on('connection', (ws, req) => {
      state.connectionCount += 1;
      state.openCount += 1;
      ws.on('close', () => {
        state.openCount -= 1;
      });

      const url = req.url || '';
      if (url.startsWith('/logs')) {
        state.logSockets.push(ws);
        ws.on('close', () => {
          state.logSockets = state.logSockets.filter((s) => s !== ws);
        });
      } else if (url.startsWith('/connections')) {
        state.connectionSockets.push(ws);
        ws.on('close', () => {
          state.connectionSockets = state.connectionSockets.filter((s) => s !== ws);
        });
      }
    });

    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        wss,
        port,
        get refuseConnections() {
          return state.refuseConnections;
        },
        set refuseConnections(v: boolean) {
          state.refuseConnections = v;
        },
        get connectionCount() {
          return state.connectionCount;
        },
        get openCount() {
          return state.openCount;
        },
        get attemptCount() {
          return state.attemptCount;
        },
        get connectionSockets() {
          return state.connectionSockets;
        },
        get logSockets() {
          return state.logSockets;
        },
        sendConnectionsSnapshot(data: unknown) {
          const socket = state.connectionSockets.at(-1);
          socket?.send(JSON.stringify(data));
        },
        pushLogs(n: number) {
          const socket = state.logSockets.at(-1);
          if (!socket) throw new Error('no /logs upstream connection');
          for (let i = 0; i < n; i++) {
            socket.send(JSON.stringify({ type: 'debug', payload: `line-${i}` }));
          }
        },
        close(): Promise<void> {
          return new Promise((r) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => r());
          });
        },
      } as FakeUpstream);
    });
  });
}

// Matches topic-hub.test.ts's fakeWs pattern: routed through a plain object
// first so `this` inside `send()` isn't collapsed to `never` by the cast.
function fakeWs() {
  const obj = { readyState: 1, bufferedAmount: 0, sent: [] as string[] };
  return obj as never;
}

function createHubStub() {
  const snapshots: Array<{ topic: string; backendId: number; json: string }> = [];
  const appends: Array<{ topic: string; backendId: number; json: string }> = [];
  const errors: Array<{ topic: string; backendId: number; error: string }> = [];
  const stub = {
    publishSnapshot: (topic: string, backendId: number, json: string) => {
      snapshots.push({ topic, backendId, json });
    },
    publishAppend: (topic: string, backendId: number, json: string) => {
      appends.push({ topic, backendId, json });
    },
    publishError: (topic: string, backendId: number, error: string) => {
      errors.push({ topic, backendId, error });
    },
    sendTo: (ws: { sent: string[] }, json: string) => {
      ws.sent.push(json);
    },
  };
  return { hub: stub as unknown as TopicHub, snapshots, appends, errors };
}

describe('ManagementRelay', () => {
  let upstream: FakeUpstream;
  let db: StatsDatabase;
  let cleanupDb: () => void;
  let backendId: number;
  let relay: ManagementRelay | undefined;

  beforeEach(async () => {
    upstream = await createFakeUpstream();
    ({ db, cleanup: cleanupDb } = createTestDatabase());
    backendId = db.createBackend({
      name: 'relay-test',
      url: `http://127.0.0.1:${upstream.port}`,
      token: '',
      apiUrl: `http://127.0.0.1:${upstream.port}`,
      apiSecret: '',
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    relay?.stop();
    relay = undefined;
    cleanupDb();
    await upstream.close();
  });

  it('lazily connects upstream on first subscriber and disconnects after linger on last unsubscribe', async () => {
    const { hub } = createHubStub();
    relay = new ManagementRelay({ db, hub });

    expect(upstream.connectionCount).toBe(0);
    relay.hooks.onFirstSubscriber('connections', backendId);
    await vi.waitFor(() => expect(upstream.connectionCount).toBe(1));
    await vi.waitFor(() => expect(relay!.channelState(backendId, 'connections')).toBe('open'));

    vi.useFakeTimers();
    relay.hooks.onLastUnsubscriber('connections', backendId);
    vi.advanceTimersByTime(31_000);
    vi.useRealTimers();

    await vi.waitFor(() => expect(upstream.openCount).toBe(0));
    expect(relay.channelState(backendId, 'connections')).toBe('idle');
  });

  it('ignores the delay topic entirely — no upstream channel, Task 2 owns it via REST-triggered publishAppend', async () => {
    const { hub } = createHubStub();
    relay = new ManagementRelay({ db, hub });

    relay.hooks.onFirstSubscriber('delay', backendId);
    // Give any (incorrect) async connect attempt a moment to happen.
    await new Promise((r) => setTimeout(r, 100));

    expect(relay.channelState(backendId, 'delay')).toBe('idle');
    expect(upstream.attemptCount).toBe(0);
    expect(upstream.connectionCount).toBe(0);
  });

  it('re-subscribing within the linger window keeps the upstream connection', async () => {
    const { hub } = createHubStub();
    relay = new ManagementRelay({ db, hub });

    relay.hooks.onFirstSubscriber('connections', backendId);
    await vi.waitFor(() => expect(upstream.connectionCount).toBe(1));
    await vi.waitFor(() => expect(relay!.channelState(backendId, 'connections')).toBe('open'));

    vi.useFakeTimers();
    relay.hooks.onLastUnsubscriber('connections', backendId);
    vi.advanceTimersByTime(5_000); // still inside the 30s linger window
    relay.hooks.onFirstSubscriber('connections', backendId); // quick resub cancels linger
    vi.advanceTimersByTime(30_000); // would have expired the original linger by now
    vi.useRealTimers();

    // Give the (fake-timer-driven) synchronous teardown, if any fired
    // incorrectly, a moment to be observed on the real event loop.
    await new Promise((r) => setTimeout(r, 50));
    expect(upstream.connectionCount).toBe(1); // no reconnect happened
    expect(upstream.openCount).toBe(1); // original connection still alive
    expect(relay.channelState(backendId, 'connections')).toBe('open');
  });

  it('fans out connection snapshots through publishSnapshot, one stringify per backend', async () => {
    const { hub, snapshots } = createHubStub();
    relay = new ManagementRelay({ db, hub });

    relay.hooks.onFirstSubscriber('connections', backendId);
    await vi.waitFor(() => expect(relay!.channelState(backendId, 'connections')).toBe('open'));

    upstream.sendConnectionsSnapshot({ connections: [{ id: 'c1' }] });
    await vi.waitFor(() => expect(snapshots.length).toBe(1));

    expect(snapshots[0]).toMatchObject({ topic: 'connections', backendId });
    const parsed = JSON.parse(snapshots[0].json);
    expect(parsed).toMatchObject({
      type: 'topic',
      topic: 'connections',
      backendId,
      data: { connections: [{ id: 'c1' }] },
    });
  });

  it('replays the log ring buffer to a late subscriber before streaming increments', async () => {
    const { hub, appends } = createHubStub();
    relay = new ManagementRelay({ db, hub });

    relay.hooks.onFirstSubscriber('logs', backendId);
    await vi.waitFor(() => expect(relay!.channelState(backendId, 'logs')).toBe('open'));

    upstream.pushLogs(600); // exceeds the 500-entry ring capacity
    await vi.waitFor(() => expect(appends.length).toBe(600));

    const late = fakeWs();
    relay.onSubscriberJoined(late, 'logs', backendId);

    const replayed = (late as unknown as { sent: string[] }).sent.filter((j) => j.includes('"topic":"logs"'));
    expect(replayed).toHaveLength(500); // only the most recent 500 survive
    expect(replayed[0]).toContain('"seq":100'); // oldest 100 were evicted
    expect(replayed.at(-1)).toContain('"seq":599');

    // Pin the upstream `type` -> our `level` translation and the payload
    // text, not just seq — the browser renders both. replayed[0] is seq 100
    // (the oldest surviving entry), which pushLogs sent as
    // {"type":"debug","payload":"line-100"}.
    const firstReplayed = JSON.parse(replayed[0]);
    expect(firstReplayed.data).toMatchObject({ seq: 100, level: 'debug', payload: 'line-100' });
  });

  it('opens the circuit after 5 consecutive failures and publishes reachable:false', async () => {
    const { hub, errors } = createHubStub();
    // Tiny real backoff constants: keeps the test fast and deterministic
    // without mixing fake timers with the real socket-rejection I/O that
    // verifyClient drives on each attempt.
    relay = new ManagementRelay({ db, hub, reconnectBaseMs: 5, reconnectMaxMs: 20 });

    upstream.refuseConnections = true;
    relay.hooks.onFirstSubscriber('connections', backendId);

    await vi.waitFor(
      () =>
        expect(errors).toContainEqual(
          expect.objectContaining({ topic: 'connections', backendId }),
        ),
      { timeout: 3000 },
    );
    expect(relay.channelState(backendId, 'connections')).toBe('circuit-open');
    expect(errors[0].error).toBeTruthy();
  });

  it('notifies a late subscriber joining an already circuit-open channel, without re-broadcasting to existing subscribers', async () => {
    const { hub, errors } = createHubStub();
    relay = new ManagementRelay({ db, hub, reconnectBaseMs: 5, reconnectMaxMs: 20 });

    upstream.refuseConnections = true;
    relay.hooks.onFirstSubscriber('connections', backendId); // subscriber A
    await vi.waitFor(
      () => expect(relay!.channelState(backendId, 'connections')).toBe('circuit-open'),
      { timeout: 3000 },
    );
    expect(errors).toHaveLength(1); // the trip itself broadcasts once (reaches A)

    const lateB = fakeWs();
    relay.onSubscriberJoined(lateB, 'connections', backendId);

    const bMessages = (lateB as unknown as { sent: string[] }).sent;
    const bErrors = bMessages.filter((j) => j.includes('"type":"topic-error"'));
    expect(bErrors).toHaveLength(1);
    const parsed = JSON.parse(bErrors[0]);
    expect(parsed).toMatchObject({ type: 'topic-error', topic: 'connections', backendId, reachable: false });
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error.length).toBeGreaterThan(0);

    // Not a re-broadcast: publishError (which a real TopicHub would fan out
    // to every already-subscribed client, i.e. A) must not fire again just
    // because B joined — B's notification goes only through hub.sendTo.
    expect(errors).toHaveLength(1);
  });

  it('refuses (publishError) immediately when the backend has no api_url at acquire time, no retries', async () => {
    const { hub, errors } = createHubStub();
    relay = new ManagementRelay({ db, hub });
    const noMgmtBackendId = db.createBackend({ name: 'no-mgmt', url: 'agent://x', token: '', agentToken: 't' });

    relay.hooks.onFirstSubscriber('connections', noMgmtBackendId);

    // No backoff/retry involved (unlike a real network failure) — refusal
    // is synchronous with acquire, so this must not need vi.waitFor at all.
    expect(errors).toContainEqual(
      expect.objectContaining({ topic: 'connections', backendId: noMgmtBackendId }),
    );
    expect(relay.channelState(noMgmtBackendId, 'connections')).toBe('circuit-open');
  });

  it('resets the circuit breaker after a full linger teardown, not only on a circuit-open resubscribe', async () => {
    const { hub, errors } = createHubStub();
    relay = new ManagementRelay({ db, hub, reconnectBaseMs: 5, reconnectMaxMs: 20 });

    upstream.refuseConnections = true;
    relay.hooks.onFirstSubscriber('connections', backendId);
    await vi.waitFor(
      () => expect(relay!.channelState(backendId, 'connections')).toBe('circuit-open'),
      { timeout: 3000 },
    );
    expect(upstream.attemptCount).toBe(5); // exactly 5 attempts trip the breaker
    expect(errors).toHaveLength(1);

    // Let the channel fully tear down (no subscribers, linger expires) —
    // distinct from resubscribing while still circuit-open.
    vi.useFakeTimers();
    relay.hooks.onLastUnsubscriber('connections', backendId);
    vi.advanceTimersByTime(31_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(relay!.channelState(backendId, 'connections')).toBe('idle'));

    // Upstream is still down when the subscriber returns. A stale failure
    // count would re-trip the breaker off a single attempt (consecutiveFailures
    // 5 -> 6); a properly reset count must burn through a fresh run of 5.
    const attemptsBeforeReturn = upstream.attemptCount;
    relay.hooks.onFirstSubscriber('connections', backendId);
    await vi.waitFor(
      () => expect(relay!.channelState(backendId, 'connections')).toBe('circuit-open'),
      { timeout: 3000 },
    );
    expect(upstream.attemptCount - attemptsBeforeReturn).toBe(5);
    expect(errors).toHaveLength(2);
  });

  // M1 final-review fix wave, finding 6: the heartbeat watchdog itself
  // (startHeartbeat's setInterval in ws-relay.ts) had no direct coverage —
  // only the circuit breaker's connection-failure path was tested above.
  // `ws`'s Receiver auto-responds to an incoming ping frame with a pong at
  // the protocol layer regardless of application code, so a real fake-
  // upstream WebSocketServer can't be made "silent" by simply not wiring up
  // a message handler — lastActivity would keep resetting via the 'pong'
  // event no matter what. Mocking WebSocket.prototype.ping to a no-op is
  // what actually makes the channel's own ping never go out, so no pong (and
  // no message) ever arrives and lastActivity genuinely goes stale.
  it('terminates a silently-dead upstream via the heartbeat watchdog and reconnects', async () => {
    const { hub } = createHubStub();
    const pingSpy = vi.spyOn(WebSocket.prototype, 'ping').mockImplementation(() => {});
    relay = new ManagementRelay({
      db,
      hub,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 50,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
    });

    relay.hooks.onFirstSubscriber('connections', backendId);
    await vi.waitFor(() => expect(relay!.channelState(backendId, 'connections')).toBe('open'));
    // Snapshot the count AT this observation rather than asserting it's
    // exactly 1: `vi.waitFor` polls on an interval, and a late poll (loaded
    // CI runner, contention from the rest of the suite) could observe
    // 'open' only after a termination-and-reconnect cycle already bumped
    // the count past 1 — asserting an exact value here would flake on
    // exactly the timing this test intentionally races.
    const countAtOpen = upstream.connectionCount;

    // With ping() a no-op, no pong (and no message) ever arrives — idle
    // time on the channel's own clock exceeds heartbeatTimeoutMs and the
    // watchdog must terminate() the socket, which drives a reconnect.
    // Reconnected sockets are equally silent (same mocked ping), so the
    // channel keeps cycling open -> terminate -> reconnect indefinitely;
    // `connectionCount` (monotonic: every accepted connection, never
    // decremented) growing past its value at the 'open' observation is the
    // only safe thing to assert, not a transient state like `channelState()`
    // or `openCount`, or an exact count.
    await vi.waitFor(() => expect(upstream.connectionCount).toBeGreaterThan(countAtOpen), {
      timeout: 2000,
    });

    pingSpy.mockRestore();
  });
});
