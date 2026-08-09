/**
 * Management Relay — per-backend WebSocket relay for the `connections` and
 * `logs` management topics (M1 Task 3).
 *
 * One `RelayChannel` per (backendId, topic) pair, lazily created on first
 * subscriber and torn down after a 30s linger once the last subscriber
 * leaves (quick page navigation must not thrash the upstream connection).
 * Reconnection mirrors `gateway.collector.ts`'s pattern: exponential backoff
 * (`calculateBackoffDelay`) plus a heartbeat watchdog that terminates a
 * silently-dead link. Five consecutive connection failures trip a circuit
 * breaker — retries stop and `hub.publishError` announces `reachable:
 * false` — until a subscriber count 0→1 transition resets it.
 *
 * `connections` is snapshot semantics: each upstream frame is parsed once
 * and forwarded via `hub.publishSnapshot` (fan-out/throttling is the hub's
 * job, not this module's). `logs` is append semantics: every frame is
 * seq-stamped, kept in a 500-entry ring buffer, and forwarded via
 * `hub.publishAppend`; a newly-joined subscriber gets the buffered history
 * replayed via `hub.sendTo` before any further increment reaches it.
 */

import WebSocket from 'ws';
import type { StatsDatabase } from '../db/db.js';
import { getGatewayBaseUrl } from '@mihomo-orbit/shared';
import { calculateBackoffDelay } from '../../shared/utils/backoff.js';
import type { TopicHub, TopicHubHooks, TopicName } from '../websocket/topic-hub.js';

export type ChannelState = 'idle' | 'connecting' | 'open' | 'circuit-open';

// Invariant shared with the web client (logs-page.tsx's SOFT_CAP/HARD_CAP)
// and the hub's own APPEND_QUEUE_LIMIT (topic-hub.ts): this ring must stay
// <= SOFT_CAP (1000) minus the max append-queue lag (200) a client can
// accumulate before a queue-limit drop. If this ring ever grew past that
// margin, a replay after a client's queue overflow could hand back more
// history than the client's own seq-range dedup window can absorb,
// misfiring a spurious "stream reset" on logs-page.tsx.
const LOG_RING_CAPACITY = 500;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const DEFAULT_RECONNECT_BASE_MS = 2000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_LINGER_MS = 30_000;

export interface ManagementRelayDeps {
  db: StatsDatabase;
  hub: TopicHub;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  lingerMs?: number;
}

interface ResolvedRelayDeps {
  db: StatsDatabase;
  hub: TopicHub;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  lingerMs: number;
}

interface LogEntry {
  seq: number;
  level: string;
  payload: string;
  ts: number;
}

function channelKey(topic: TopicName, backendId: number): string {
  return `${topic}:${backendId}`;
}

// This relay only owns an upstream connection for `connections` and `logs`.
// `delay` is a valid topic-subscribe target too (see websocket.server.ts's
// TOPIC_NAMES), but it has no Mihomo upstream stream at all — group delay
// test results are published directly by ManagementService (Task 2) via
// REST-triggered hub.publishAppend calls. TopicHub's onFirstSubscriber /
// onLastUnsubscriber hooks fire for every topic without filtering, so this
// relay must ignore `delay` itself rather than mistakenly opening a
// `/logs?level=debug` connection for it.
function isRelayManagedTopic(topic: TopicName): topic is 'connections' | 'logs' {
  return topic === 'connections' || topic === 'logs';
}

class RelayChannel {
  private state: ChannelState = 'idle';
  private ws: WebSocket | null = null;
  private refCount = 0;
  private consecutiveFailures = 0;
  private isStopped = false;
  private lastActivity = 0;
  // The error message from the most recent circuit-open trip, so a
  // subscriber joining an already-tripped channel (TopicHub.subscribe adds
  // it to a non-empty set, so onFirstSubscriber never fires for it) can
  // still be told the channel is down instead of hanging silently.
  private lastErrorMessage: string | null = null;

  private lingerTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Ring buffer: fixed-size array + write pointer (per m1-contracts.md /
  // the task brief), not an array.shift() — this stays O(1) per append
  // regardless of log volume.
  private readonly ring: (LogEntry | undefined)[] = new Array(LOG_RING_CAPACITY);
  private ringWritePos = 0;
  private ringFilled = 0;
  private nextSeq = 0;

  constructor(
    private readonly topic: TopicName,
    private readonly backendId: number,
    private readonly deps: ResolvedRelayDeps,
  ) {}

  getState(): ChannelState {
    return this.state;
  }

  acquire(): void {
    this.refCount += 1;
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    if (this.refCount !== 1) return;

    // Subscriber count 0->1 after a trip resets the breaker so the user
    // re-opening the page gets a fresh run of attempts.
    if (this.state === 'circuit-open') {
      this.consecutiveFailures = 0;
    }
    if (this.state === 'idle' || this.state === 'circuit-open') {
      this.connect();
    }
  }

  release(): void {
    if (this.refCount > 0) this.refCount -= 1;
    if (this.refCount !== 0) return;

    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      this.teardown();
    }, this.deps.lingerMs);
    this.lingerTimer.unref?.();
  }

  /** Replays the buffered log ring to a newly-joined subscriber. No-op for
   *  the `connections` topic (snapshot semantics have nothing to replay). */
  replayTo(ws: WebSocket): void {
    if (this.topic !== 'logs') return;
    for (const entry of this.orderedLogEntries()) {
      this.deps.hub.sendTo(ws, this.encodeLogEntry(entry));
    }
  }

  /** A subscriber joining a channel that's already circuit-open never gets
   *  an onFirstSubscriber call (TopicHub.subscribe only fires that on a
   *  0->1 transition, and this channel already has other subscribers keeping
   *  it non-empty) — without this, that socket would hang silently until the
   *  channel happens to cycle through zero subscribers. Sent via
   *  hub.sendTo (one socket only), never hub.publishError, which would
   *  re-broadcast a duplicate error to every already-subscribed client. */
  notifyIfCircuitOpen(ws: WebSocket): void {
    if (this.state !== 'circuit-open') return;
    const error = this.lastErrorMessage ?? 'management upstream unreachable';
    this.deps.hub.sendTo(ws, this.encodeTopicError(error));
  }

  /** Process-exit teardown: unlike a linger expiry, this must never
   *  reconnect again even if acquire() is somehow called afterward. */
  stop(): void {
    this.isStopped = true;
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.teardown();
  }

  private connect(): void {
    if (this.isStopped) return;
    this.state = 'connecting';

    const backend = this.deps.db.getBackend(this.backendId);
    const apiUrl = (backend?.api_url || '').trim();
    if (!backend || !apiUrl) {
      // "A relay must refuse if the backend disappears or api_url is empty
      // at acquire time" — literally at acquire time: go straight to
      // circuit-open instead of burning through backoff attempts against a
      // URL that isn't merely down but doesn't exist. acquire()'s 0->1
      // circuit-open reset still lets a later config fix (or a returning
      // subscriber) try again.
      this.state = 'circuit-open';
      this.lastErrorMessage = 'backend has no management api_url configured';
      this.deps.hub.publishError(this.topic, this.backendId, this.lastErrorMessage);
      return;
    }

    const httpBase = getGatewayBaseUrl(apiUrl);
    const wsBase = httpBase.replace(/^http/, 'ws');
    const path = this.topic === 'connections' ? '/connections' : '/logs?level=debug';
    const url = `${wsBase}${path}`;

    // Auth via header only — never the URL query string (would land in
    // reverse-proxy access logs / upstream server logs). Mirrors
    // gateway.collector.ts's upstream connection construction.
    const headers: Record<string, string> = { Origin: httpBase };
    if (backend.api_secret) {
      headers.Authorization = `Bearer ${backend.api_secret}`;
    }

    // followRedirects deliberately left at ws's default (false): Mihomo's
    // controller never redirects, and enabling it would let the capital-A
    // Authorization header survive ws's cross-host redirect credential scrub
    // if a MITM / misconfigured proxy ever did redirect this request.
    const ws = new WebSocket(url, { headers });
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.state = 'open';
      this.consecutiveFailures = 0;
      this.startHeartbeat();
    });

    ws.on('message', (data: WebSocket.Data) => {
      if (this.ws !== ws) return;
      this.lastActivity = Date.now();
      this.handleMessage(data);
    });

    ws.on('pong', () => {
      if (this.ws !== ws) return;
      this.lastActivity = Date.now();
    });

    ws.on('error', () => {
      // Swallowed: 'close' always follows and drives reconnect/circuit
      // logic — no separate handling needed here.
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.handleDisconnect();
    });
  }

  private handleDisconnect(): void {
    this.stopHeartbeat();
    this.ws = null;
    if (this.isStopped) return;

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.state = 'circuit-open';
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.lastErrorMessage = 'management upstream unreachable after repeated connection failures';
      this.deps.hub.publishError(this.topic, this.backendId, this.lastErrorMessage);
      return;
    }

    this.state = 'connecting';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const attempt = Math.max(0, this.consecutiveFailures - 1);
    const delay = calculateBackoffDelay(attempt, this.deps.reconnectBaseMs, this.deps.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastActivity = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;

      const idle = Date.now() - this.lastActivity;
      if (idle > this.deps.heartbeatTimeoutMs) {
        // terminate() emits 'close', which routes through handleDisconnect.
        ws.terminate();
        return;
      }

      try {
        ws.ping();
      } catch {
        // Socket already unusable; the timeout branch above will reconnect it.
      }
    }, this.deps.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private teardown(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.terminate();
    }
    this.state = 'idle';
    // A full teardown is a clean slate: without this, a breaker tripped
    // while subscribers were still around (consecutiveFailures >= 5) would
    // survive the linger expiry, and a subscriber returning later (state
    // now 'idle', not 'circuit-open') would skip acquire()'s circuit-open
    // reset and trip straight back to circuit-open on its very first retry.
    this.consecutiveFailures = 0;
  }

  private handleMessage(data: WebSocket.Data): void {
    const raw = data.toString();

    if (this.topic === 'connections') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // malformed frame from upstream — drop it
      }
      // One stringify here, forwarded as-is: the hub fans the same string
      // out to every subscriber (and throttles) — never per-subscriber.
      this.deps.hub.publishSnapshot('connections', this.backendId, this.encodeConnectionsSnapshot(parsed));
      return;
    }

    let level = 'info';
    let payload = raw;
    try {
      const upstream = JSON.parse(raw) as { type?: string; payload?: string };
      if (typeof upstream.type === 'string') level = upstream.type;
      if (typeof upstream.payload === 'string') payload = upstream.payload;
    } catch {
      // Non-JSON frame: keep the raw text as the payload, default level.
    }

    const entry: LogEntry = { seq: this.nextSeq, level, payload, ts: Date.now() };
    this.nextSeq += 1;
    this.pushLog(entry);
    this.deps.hub.publishAppend('logs', this.backendId, this.encodeLogEntry(entry));
  }

  private pushLog(entry: LogEntry): void {
    this.ring[this.ringWritePos] = entry;
    this.ringWritePos = (this.ringWritePos + 1) % LOG_RING_CAPACITY;
    this.ringFilled = Math.min(this.ringFilled + 1, LOG_RING_CAPACITY);
  }

  private orderedLogEntries(): LogEntry[] {
    if (this.ringFilled < LOG_RING_CAPACITY) {
      return this.ring.slice(0, this.ringFilled) as LogEntry[];
    }
    // Full ring: the oldest entry sits at the write pointer (next slot to
    // be overwritten); the newest is immediately before it.
    return [...this.ring.slice(this.ringWritePos), ...this.ring.slice(0, this.ringWritePos)] as LogEntry[];
  }

  private encodeConnectionsSnapshot(data: unknown): string {
    return JSON.stringify({
      type: 'topic',
      topic: 'connections',
      backendId: this.backendId,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  private encodeLogEntry(entry: LogEntry): string {
    return JSON.stringify({
      type: 'topic',
      topic: 'logs',
      backendId: this.backendId,
      data: entry,
      timestamp: new Date().toISOString(),
    });
  }

  /** Same wire shape as TopicHub.publishError's topic-error message (see
   *  topic-hub.ts): type, topic, backendId, error, reachable — no
   *  timestamp field. */
  private encodeTopicError(error: string): string {
    return JSON.stringify({
      type: 'topic-error',
      topic: this.topic,
      backendId: this.backendId,
      error,
      reachable: false,
    });
  }
}

export class ManagementRelay {
  private readonly channels = new Map<string, RelayChannel>();
  private readonly deps: ResolvedRelayDeps;
  readonly hooks: TopicHubHooks;

  constructor(deps: ManagementRelayDeps) {
    this.deps = {
      db: deps.db,
      hub: deps.hub,
      reconnectBaseMs: deps.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS,
      reconnectMaxMs: deps.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
      heartbeatIntervalMs: deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      lingerMs: deps.lingerMs ?? DEFAULT_LINGER_MS,
    };

    this.hooks = {
      onFirstSubscriber: (topic, backendId) => {
        if (!isRelayManagedTopic(topic)) return;
        this.getOrCreateChannel(topic, backendId).acquire();
      },
      onLastUnsubscriber: (topic, backendId) => {
        if (!isRelayManagedTopic(topic)) return;
        this.channels.get(channelKey(topic, backendId))?.release();
      },
    };
  }

  /** Log-history replay entry point: called by the WS server right after a
   *  successful topic-subscribe, in the same synchronous call stack, so the
   *  replay always precedes any later publishAppend for that socket. No-op
   *  for `connections` (nothing to replay for a snapshot topic) and for
   *  `delay` (not relay-managed at all — see isRelayManagedTopic).
   *
   *  Also covers a subscriber joining a channel that's already
   *  circuit-open: TopicHub.subscribe only calls onFirstSubscriber on a
   *  0->1 transition, so a second (or later) tab subscribing to a channel
   *  that already has subscribers never reaches acquire() at all — without
   *  this, it would hang with no snapshot and no error until the channel
   *  happened to cycle through zero subscribers. */
  onSubscriberJoined(ws: WebSocket, topic: TopicName, backendId: number): void {
    if (!isRelayManagedTopic(topic)) return;
    const channel = this.channels.get(channelKey(topic, backendId));
    if (!channel) return;
    channel.replayTo(ws);
    channel.notifyIfCircuitOpen(ws);
  }

  channelState(backendId: number, topic: TopicName): ChannelState {
    if (!isRelayManagedTopic(topic)) return 'idle';
    return this.channels.get(channelKey(topic, backendId))?.getState() ?? 'idle';
  }

  stop(): void {
    for (const channel of this.channels.values()) channel.stop();
    this.channels.clear();
  }

  private getOrCreateChannel(topic: TopicName, backendId: number): RelayChannel {
    const key = channelKey(topic, backendId);
    let channel = this.channels.get(key);
    if (!channel) {
      channel = new RelayChannel(topic, backendId, this.deps);
      this.channels.set(key, channel);
    }
    return channel;
  }
}
