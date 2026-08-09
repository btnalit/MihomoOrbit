import type { WebSocket } from 'ws';

export type TopicName = 'connections' | 'logs' | 'delay';

export interface TopicHubHooks {
  onFirstSubscriber(topic: TopicName, backendId: number): void;
  onLastUnsubscriber(topic: TopicName, backendId: number): void;
}

const APPEND_QUEUE_LIMIT = 200;
const DEFAULT_SNAPSHOT_THROTTLE_MS = 1000;
const FLUSH_INTERVAL_MS = 1000;

type TopicKey = string; // `${topic}:${backendId}`

function topicKeyOf(topic: TopicName, backendId: number): TopicKey {
  return `${topic}:${backendId}`;
}

function parseTopicKey(key: TopicKey): { topic: TopicName; backendId: number } {
  const idx = key.lastIndexOf(':');
  return {
    topic: key.slice(0, idx) as TopicName,
    backendId: Number(key.slice(idx + 1)),
  };
}

interface AppendQueueEntry {
  queue: string[];
  dropped: number;
  // Per-topicKey breakdown of `dropped`, so flushQueues can emit an
  // identifiable topic-gap (topic + backendId) even though a single client
  // queue is shared across every append topic it's subscribed to.
  droppedByTopic: Map<TopicKey, number>;
}

export class TopicHub {
  private readonly maxBufferedBytes: number;
  private readonly snapshotThrottleMs: number;
  private hooks: TopicHubHooks;
  private readonly sendGate: (ws: WebSocket, json: string) => boolean;

  private subs = new Map<TopicKey, Set<WebSocket>>();
  private clientTopics = new Map<WebSocket, Set<TopicKey>>();
  private pendingSnapshot = new Map<TopicKey, string>();
  private snapshotTimer = new Map<TopicKey, NodeJS.Timeout>();
  // No entry = "never sent yet" — distinct from a real timestamp of 0 so a
  // fake-timers clock starting at epoch 0 still treats the first publish as
  // immediate.
  private lastSnapshotSentAt = new Map<TopicKey, number>();
  private appendQueues = new Map<WebSocket, AppendQueueEntry>();
  private flushTimer: NodeJS.Timeout;

  constructor(opts: {
    maxBufferedBytes: number;
    snapshotThrottleMs?: number;
    hooks?: TopicHubHooks;
    sendGate?: (ws: WebSocket, json: string) => boolean;
  }) {
    this.maxBufferedBytes = opts.maxBufferedBytes;
    this.snapshotThrottleMs = opts.snapshotThrottleMs ?? DEFAULT_SNAPSHOT_THROTTLE_MS;
    this.hooks = opts.hooks ?? {
      onFirstSubscriber: () => {},
      onLastUnsubscriber: () => {},
    };
    this.sendGate = opts.sendGate ?? ((ws, json) => this.defaultSendGate(ws, json));

    this.flushTimer = setInterval(() => this.flushQueues(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  /** Allows the host to inject topic lifecycle hooks after construction
   *  (Task 3's relay wiring) — no-op hooks are used until this is called. */
  setHooks(hooks: TopicHubHooks): void {
    this.hooks = hooks;
  }

  /** Built-in send gate used when the host doesn't inject its own gated send
   *  (used by tests): readyState + bufferedAmount semantics only, no metrics. */
  private defaultSendGate(ws: WebSocket, json: string): boolean {
    if (ws.readyState !== 1 /* OPEN */) return false;
    if (ws.bufferedAmount > this.maxBufferedBytes) return false;
    ws.send(json);
    return true;
  }

  subscribe(ws: WebSocket, topic: TopicName, backendId: number): void {
    const key = topicKeyOf(topic, backendId);

    let set = this.subs.get(key);
    if (!set) {
      set = new Set();
      this.subs.set(key, set);
    }
    const wasEmpty = set.size === 0;
    set.add(ws);

    let topics = this.clientTopics.get(ws);
    if (!topics) {
      topics = new Set();
      this.clientTopics.set(ws, topics);
    }
    topics.add(key);

    if (wasEmpty) {
      this.hooks.onFirstSubscriber(topic, backendId);
    }
  }

  unsubscribe(ws: WebSocket, topic: TopicName, backendId: number): void {
    const key = topicKeyOf(topic, backendId);
    this.removeSubscription(ws, key);
  }

  private removeSubscription(ws: WebSocket, key: TopicKey): void {
    const set = this.subs.get(key);
    if (set) {
      const had = set.delete(ws);
      if (had && set.size === 0) {
        this.subs.delete(key);
        const { topic, backendId } = parseTopicKey(key);
        this.hooks.onLastUnsubscriber(topic, backendId);
      }
    }

    const topics = this.clientTopics.get(ws);
    if (topics) {
      topics.delete(key);
      if (topics.size === 0) {
        this.clientTopics.delete(ws);
      }
    }
  }

  dropClient(ws: WebSocket): void {
    const topics = this.clientTopics.get(ws);
    if (topics) {
      // Copy first: removeSubscription mutates `topics` (via clientTopics.get(ws)) as it iterates.
      for (const key of Array.from(topics)) {
        this.removeSubscription(ws, key);
      }
    }
    this.appendQueues.delete(ws);
  }

  subscriberCount(topic: TopicName, backendId: number): number {
    return this.subs.get(topicKeyOf(topic, backendId))?.size ?? 0;
  }

  publishSnapshot(topic: TopicName, backendId: number, json: string): void {
    const key = topicKeyOf(topic, backendId);
    const set = this.subs.get(key);
    if (!set || set.size === 0) return;

    const lastSent = this.lastSnapshotSentAt.get(key);
    const elapsed = lastSent === undefined ? Infinity : Date.now() - lastSent;

    if (elapsed >= this.snapshotThrottleMs) {
      this.sendSnapshotNow(key, set, json);
      return;
    }

    // Within the throttle window: keep only the latest pending value, and
    // arm a one-shot timer (if not already armed) to flush it at the window
    // boundary.
    this.pendingSnapshot.set(key, json);
    if (!this.snapshotTimer.has(key)) {
      const delay = this.snapshotThrottleMs - elapsed;
      const timer = setTimeout(() => {
        this.snapshotTimer.delete(key);
        const pending = this.pendingSnapshot.get(key);
        this.pendingSnapshot.delete(key);
        if (pending === undefined) return;
        const currentSet = this.subs.get(key);
        if (!currentSet || currentSet.size === 0) return;
        this.sendSnapshotNow(key, currentSet, pending);
      }, delay);
      timer.unref?.();
      this.snapshotTimer.set(key, timer);
    }
  }

  private sendSnapshotNow(key: TopicKey, set: Set<WebSocket>, json: string): void {
    this.lastSnapshotSentAt.set(key, Date.now());
    for (const ws of set) {
      // Backpressured clients are skipped, not queued — snapshot semantics.
      this.sendGate(ws, json);
    }
  }

  publishAppend(topic: TopicName, backendId: number, json: string): void {
    const key = topicKeyOf(topic, backendId);
    const set = this.subs.get(key);
    if (!set || set.size === 0) return;

    for (const ws of set) {
      const sent = this.sendGate(ws, json);
      if (!sent) {
        this.enqueueAppend(ws, key, json);
      }
    }
  }

  private enqueueAppend(ws: WebSocket, topicKey: TopicKey, json: string): void {
    let entry = this.appendQueues.get(ws);
    if (!entry) {
      entry = { queue: [], dropped: 0, droppedByTopic: new Map() };
      this.appendQueues.set(ws, entry);
    }
    entry.queue.push(json);
    if (entry.queue.length > APPEND_QUEUE_LIMIT) {
      entry.queue.shift();
      entry.dropped += 1;
      entry.droppedByTopic.set(topicKey, (entry.droppedByTopic.get(topicKey) ?? 0) + 1);
    }
  }

  /** Explicit flush entry point shared by the 1s timer and tests. */
  flushQueues(): void {
    for (const [ws, entry] of this.appendQueues) {
      if (entry.queue.length === 0 && entry.dropped === 0) {
        this.appendQueues.delete(ws);
        continue;
      }

      if (entry.dropped > 0) {
        let blocked = false;
        for (const [topicKey, count] of entry.droppedByTopic) {
          if (count <= 0) continue;
          const { topic, backendId } = parseTopicKey(topicKey);
          const gap = JSON.stringify({ type: 'topic-gap', topic, backendId, dropped: count });
          if (!this.sendGate(ws, gap)) {
            blocked = true;
            break;
          }
          // Only clear the counter once the gap has actually been
          // delivered — clearing it beforehand would silently drop the
          // notification if the client is still backpressured.
          entry.dropped -= count;
          entry.droppedByTopic.delete(topicKey);
        }
        if (blocked) continue;
      }

      while (entry.queue.length > 0) {
        const next = entry.queue[0];
        if (!this.sendGate(ws, next)) {
          break;
        }
        entry.queue.shift();
      }

      if (entry.queue.length === 0 && entry.dropped === 0) {
        this.appendQueues.delete(ws);
      }
    }
  }

  sendTo(ws: WebSocket, json: string): void {
    this.sendGate(ws, json);
  }

  publishError(topic: TopicName, backendId: number, error: string): void {
    const key = topicKeyOf(topic, backendId);
    const set = this.subs.get(key);
    if (!set || set.size === 0) return;

    const json = JSON.stringify({ type: 'topic-error', topic, backendId, error });
    for (const ws of set) {
      this.sendGate(ws, json);
    }
  }
}
