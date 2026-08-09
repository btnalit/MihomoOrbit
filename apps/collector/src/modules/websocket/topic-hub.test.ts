import { describe, expect, it, vi } from 'vitest';
import { TopicHub } from './topic-hub.js';

const OPEN = 1;
function fakeWs(bufferedAmount = 0) {
  // Assigned to a variable before the cast: TS propagates `as never` as a
  // contextual type backward into the object literal's `this` inference
  // when the cast is applied directly to the literal, collapsing `this` to
  // `never` inside `send()`. Routing through `obj` avoids that (type-only
  // change; runtime behavior and all assertions below are unaffected).
  const obj = { readyState: OPEN, bufferedAmount, sent: [] as string[],
    send(j: string) { this.sent.push(j); } };
  return obj as never;
}

describe('TopicHub', () => {
  it('fires onFirstSubscriber / onLastUnsubscriber exactly at 0->1 and 1->0', () => {
    const hooks = { onFirstSubscriber: vi.fn(), onLastUnsubscriber: vi.fn() };
    const hub = new TopicHub({ maxBufferedBytes: 1024, hooks });
    const a = fakeWs(), b = fakeWs();
    hub.subscribe(a, 'connections', 1);
    hub.subscribe(b, 'connections', 1);
    expect(hooks.onFirstSubscriber).toHaveBeenCalledTimes(1);
    hub.unsubscribe(a, 'connections', 1);
    expect(hooks.onLastUnsubscriber).not.toHaveBeenCalled();
    hub.dropClient(b);
    expect(hooks.onLastUnsubscriber).toHaveBeenCalledTimes(1);
  });

  it('snapshot topics coalesce under throttle: only the latest survives', async () => {
    vi.useFakeTimers();
    const hub = new TopicHub({ maxBufferedBytes: 1024, snapshotThrottleMs: 1000 });
    const ws = fakeWs();
    hub.subscribe(ws, 'connections', 1);
    hub.publishSnapshot('connections', 1, 'v1');   // 立发
    hub.publishSnapshot('connections', 1, 'v2');   // 节流窗口内,挂起
    hub.publishSnapshot('connections', 1, 'v3');   // 覆盖 v2
    vi.advanceTimersByTime(1001);
    expect((ws as never as { sent: string[] }).sent).toEqual(['v1', 'v3']);
    vi.useRealTimers();
  });

  it('backpressured client is skipped for snapshots, not queued', () => {
    const hub = new TopicHub({ maxBufferedBytes: 10 });
    const slow = fakeWs(9999);
    hub.subscribe(slow, 'connections', 1);
    hub.publishSnapshot('connections', 1, 'v1');
    expect((slow as never as { sent: string[] }).sent).toEqual([]);
  });

  it('append topics queue for a backpressured client, overflow drops oldest and injects a gap', () => {
    const hub = new TopicHub({ maxBufferedBytes: 10 });
    const slow = fakeWs(9999);
    hub.subscribe(slow, 'logs', 1);
    const PUBLISH_COUNT = 250;
    const QUEUE_CAP = 200; // matches TopicHub's internal APPEND_QUEUE_LIMIT
    for (let i = 0; i < PUBLISH_COUNT; i++) hub.publishAppend('logs', 1, `m${i}`);
    (slow as never as { bufferedAmount: number }).bufferedAmount = 0;
    hub.flushQueues();   // 供测试与定时器共用的显式冲队列入口
    const sent = (slow as never as { sent: string[] }).sent;
    expect(sent.length).toBeLessThanOrEqual(201);          // 200 条上限 + 1 条 gap
    expect(sent.some((j) => j.includes('topic-gap'))).toBe(true);
    expect(sent.some((j) => j.includes('m249'))).toBe(true); // 最新的保住了
    expect(sent.some((j) => j.includes('"m0"'))).toBe(false); // 最旧的被丢了

    const gapMessage = sent.find((j) => j.includes('topic-gap'));
    expect(gapMessage).toBeDefined();
    const gap = JSON.parse(gapMessage as string);
    expect(gap.dropped).toBe(PUBLISH_COUNT - QUEUE_CAP); // 50
    expect(gap.topic).toBe('logs');
    expect(gap.backendId).toBe(1);
  });

  it('a new frame is enqueued (never sent directly) while a client already has a queue, preserving order', () => {
    const hub = new TopicHub({ maxBufferedBytes: 10 });
    const slow = fakeWs(9999);
    hub.subscribe(slow, 'logs', 1);

    // Backpressure the client so 'm0'/'m1' queue instead of sending.
    hub.publishAppend('logs', 1, 'm0');
    hub.publishAppend('logs', 1, 'm1');
    expect((slow as never as { sent: string[] }).sent).toEqual([]);

    // Socket looks drained now, but the queue is still non-empty — the next
    // publish must NOT overtake it via a direct send.
    (slow as never as { bufferedAmount: number }).bufferedAmount = 0;
    hub.publishAppend('logs', 1, 'm2');

    // Still nothing sent directly: 'm2' went to the queue tail instead.
    expect((slow as never as { sent: string[] }).sent).toEqual([]);

    hub.flushQueues();
    expect((slow as never as { sent: string[] }).sent).toEqual(['m0', 'm1', 'm2']);
  });

  it('publishes only to matching topic+backendId', () => {
    const hub = new TopicHub({ maxBufferedBytes: 1024 });
    const a = fakeWs(), b = fakeWs();
    hub.subscribe(a, 'logs', 1);
    hub.subscribe(b, 'logs', 2);
    hub.publishAppend('logs', 1, 'only-a');
    expect((a as never as { sent: string[] }).sent).toEqual(['only-a']);
    expect((b as never as { sent: string[] }).sent).toEqual([]);
  });
});
