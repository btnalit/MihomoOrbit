"use client";

/**
 * Topic WebSocket hook for M1 real-time management.
 *
 * Downstream protocol: m1-contracts.md §下行协议契约. Opens its own
 * connection to the same collector WS endpoint used by `useStatsWebSocket`
 * (reusing its URL-candidate/fallback logic), declares `{stats:false}` so
 * the collector doesn't also push stats snapshots down this socket, then
 * subscribes to exactly one topic for one backend. Reconnects with
 * exponential backoff and re-subscribes automatically on reconnect;
 * unsubscribes explicitly before switching topic/backend or unmounting.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthState } from "@/lib/auth-queries";
import { getWsUrlCandidates, type ConnectionStatus } from "./websocket";

export type { ConnectionStatus };

export type TopicName = "connections" | "logs" | "delay";

export interface TopicDataMessage<T = unknown> {
  type: "topic";
  topic: TopicName;
  backendId: number;
  data: T;
  timestamp: string;
}

export interface TopicGapMessage {
  type: "topic-gap";
  topic: TopicName;
  backendId: number;
  dropped: number;
}

export interface TopicErrorMessage {
  type: "topic-error";
  topic: TopicName;
  backendId: number;
  error: string;
  reachable: false;
}

export type TopicMessage = TopicDataMessage | TopicGapMessage | TopicErrorMessage;

export interface UseTopicSubscriptionOptions {
  topic: TopicName;
  backendId: number | undefined;
  enabled?: boolean;
  onMessage: (message: TopicMessage) => void;
}

export interface UseTopicSubscriptionResult {
  status: ConnectionStatus;
}

interface IncomingFrame {
  type: string;
  topic?: string;
  backendId?: number;
  [key: string]: unknown;
}

interface Subscription {
  topic: TopicName;
  backendId: number;
}

const MAX_RECONNECT_DELAY_MS = 30000;
const BASE_RECONNECT_DELAY_MS = 3000;

export function useTopicSubscription({
  topic,
  backendId,
  enabled = true,
  onMessage,
}: UseTopicSubscriptionOptions): UseTopicSubscriptionResult {
  // 认证尚未完成初始设置时,collector 会以 4001 拒绝 WS 握手,见 lib/websocket.ts 同款注释。
  const { data: authState } = useAuthState();
  const setupPending =
    !!authState && !authState.configured && !authState.forceAccessControlOff;
  const shouldConnect = enabled && backendId !== undefined && !setupPending;

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const wsUrlIndexRef = useRef(0);

  const topicRef = useRef(topic);
  const backendIdRef = useRef(backendId);
  const subscribedRef = useRef<Subscription | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  topicRef.current = topic;
  backendIdRef.current = backendId;

  const sendFrame = useCallback((frame: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(frame));
    }
  }, []);

  const unsubscribeCurrent = useCallback(() => {
    const sub = subscribedRef.current;
    if (sub) {
      sendFrame({ type: "topic-unsubscribe", topic: sub.topic, backendId: sub.backendId });
      subscribedRef.current = null;
    }
  }, [sendFrame]);

  const subscribeCurrent = useCallback(() => {
    const t = topicRef.current;
    const b = backendIdRef.current;
    if (b === undefined) return;
    sendFrame({ type: "topic-subscribe", topic: t, backendId: b });
    subscribedRef.current = { topic: t, backendId: b };
  }, [sendFrame]);

  const cleanupSocket = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      // Nullify handlers before closing so a stale onclose/onerror from a
      // superseded socket can't clobber state set by a newer connection.
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    if (typeof window === "undefined") return;

    setStatus("connecting");

    const wsUrls = getWsUrlCandidates();
    if (wsUrlIndexRef.current >= wsUrls.length) {
      wsUrlIndexRef.current = 0;
    }
    const wsUrl = wsUrls[wsUrlIndexRef.current]!;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        setStatus("connected");
        reconnectAttemptsRef.current = 0;
        wsUrlIndexRef.current = 0;
        subscribedRef.current = null;
        sendFrame({ type: "subscribe", stats: false });
        subscribeCurrent();
      };

      ws.onmessage = (event) => {
        let frame: IncomingFrame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }

        if (frame.type !== "topic" && frame.type !== "topic-gap" && frame.type !== "topic-error") {
          // Ignore 'stats' snapshots (harmless artifact of the shared
          // subscribe handshake) and any other frame type.
          return;
        }

        // Drop frames left over from a topic/backend we've since
        // unsubscribed from (e.g. still in flight during a topic swap on
        // the same socket) — mirrors the backendId guard in lib/websocket.ts.
        if (backendIdRef.current !== undefined && frame.backendId !== backendIdRef.current) {
          return;
        }
        if (frame.topic !== topicRef.current) {
          return;
        }

        onMessageRef.current(frame as unknown as TopicMessage);
      };

      ws.onclose = () => {
        setStatus("disconnected");
        subscribedRef.current = null;

        // Try alternate endpoint before falling back to backoff reconnect.
        if (!opened && wsUrlIndexRef.current < wsUrls.length - 1) {
          wsUrlIndexRef.current += 1;
          reconnectTimerRef.current = setTimeout(() => connect(), 200);
          return;
        }

        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttemptsRef.current),
          MAX_RECONNECT_DELAY_MS,
        );
        reconnectAttemptsRef.current++;
        reconnectTimerRef.current = setTimeout(() => connect(), delay);
      };

      ws.onerror = () => {
        setStatus("error");
      };
    } catch {
      setStatus("error");
    }
  }, [sendFrame, subscribeCurrent]);

  const disconnect = useCallback(() => {
    unsubscribeCurrent();
    reconnectAttemptsRef.current = 0;
    wsUrlIndexRef.current = 0;
    cleanupSocket();
    setStatus("disconnected");
  }, [cleanupSocket, unsubscribeCurrent]);

  // Connect / disconnect lifecycle, driven by enabled + backend + auth setup gate.
  useEffect(() => {
    if (!shouldConnect) {
      disconnect();
      return;
    }
    reconnectAttemptsRef.current = 0;
    connect();
    return () => {
      disconnect();
    };
  }, [shouldConnect, connect, disconnect]);

  // Topic/backend change while already connected: unsubscribe the old pair
  // and subscribe the new one over the same socket, instead of a full
  // reconnect. If not yet connected, `connect()`'s onopen picks up the
  // latest topic/backendId via the refs above.
  useEffect(() => {
    if (!shouldConnect) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;

    const prev = subscribedRef.current;
    if (prev && prev.topic === topic && prev.backendId === backendId) return;

    unsubscribeCurrent();
    subscribeCurrent();
  }, [topic, backendId, shouldConnect, unsubscribeCurrent, subscribeCurrent]);

  return { status };
}
