"use client";

/**
 * Live log viewer (M1 task 7). `logs` is an *append* topic
 * (m1-contracts.md) — the server replays its ring history (≤500 entries,
 * oldest-first) as ordinary `topic` frames on connect/reconnect, then keeps
 * streaming live increments over the same subscription. Each frame's `data`
 * is `{ seq, level, payload, ts }`; `seq` is monotonic per backend.
 *
 * Dedup by seq: a plain reconnect re-sends ring history we may already
 * hold, so every incoming seq is checked against the range of seqs
 * currently retained in state (`findSeqBounds`) before being appended —
 * anything inside that range is a duplicate and dropped silently. A seq
 * *below* everything we hold (not just less than the max) means the
 * collector restarted and its seq counter began again from a low value;
 * that's treated as a brand new stream and clears the list.
 *
 * Two caps, not one: `SOFT_CAP` (1000) is the normal browser-side bound —
 * applied whenever the view is stuck to the bottom (`autoStick`), a second
 * bound over the server's 500-entry ring. While paused (`!autoStick`),
 * evicting under the soft cap would shift the paused user's scroll
 * position toward newer entries on every incoming line — browsers don't
 * compensate `scrollTop` for content removed above the viewport, so the
 * "frozen" view would silently drift. Only `HARD_CAP` (2000) evicts while
 * paused, a safety valve rather than a steady-state bound; resuming
 * (scrolling back to the bottom, or the "back to latest" button) trims the
 * buffered burst back down to `SOFT_CAP` immediately. Hitting `HARD_CAP`
 * while paused surfaces an inline notice that clears on resume.
 *
 * The level filter is local/client-only — it never unsubscribes or asks
 * the server to stop sending a level. All levels (including debug, hidden
 * by default since the upstream tail is debug-level) are always received,
 * stored, and counted against the caps above; only rendering is filtered.
 * Unknown levels (anything outside debug/info/warning/error) always
 * render, regardless of filter chip state.
 *
 * Auto-scroll ("stick to bottom") is measurement-based, not event-driven:
 * `handleScroll` only *measures* distance-from-bottom to decide whether to
 * stay stuck; the effect that programmatically sets `scrollTop` on new
 * rows never toggles state itself. Setting `scrollTop` does fire a native
 * `scroll` event, which re-enters `handleScroll`, but that re-measurement
 * lands back at ~0 distance and confirms `autoStick` should stay true —
 * it settles rather than oscillating, so there's no feedback loop.
 *
 * `rowsRef`/`autoStickRef` mirror the corresponding state so
 * `handleTopicMessage` (a stable, zero-dependency callback — worth keeping
 * stable since it fires on every single log line, unlike the throttled
 * `connections` snapshot) can read the latest accumulated rows and
 * stickiness without depending on render-scoped state; `EntryRow`/`GapRow`
 * are memoized so an appended line only renders itself, not the other
 * ~1000 rows already on screen.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, ArrowDown, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useTopicSubscription, type TopicMessage } from "@/lib/management-ws";

interface LogTopicData {
  seq: number;
  level: string;
  payload: string;
  ts: number;
}

type LogRow =
  | { kind: "entry"; seq: number; level: string; payload: string; ts: number; timeLabel: string }
  | { kind: "gap"; id: number; dropped: number };

const ALL_LEVELS = ["debug", "info", "warning", "error"] as const;
type KnownLevel = (typeof ALL_LEVELS)[number];

// Normal cap while stuck to the bottom, vs. the paused safety valve — see
// file header comment.
const SOFT_CAP = 1000;
const HARD_CAP = 2000;

// Only the four documented levels are known to the filter chips; anything
// else (a level string the upstream might add later) always renders — see
// file header comment.
const KNOWN_LEVEL_SET: ReadonlySet<string> = new Set(ALL_LEVELS);

const LEVEL_CLASSES: Record<KnownLevel, string> = {
  debug: "border-transparent bg-slate-500/10 text-slate-600 dark:text-slate-400",
  info: "border-transparent bg-sky-500/10 text-sky-600 dark:text-sky-400",
  warning: "border-transparent bg-amber-500/10 text-amber-600 dark:text-amber-400",
  error: "border-transparent bg-rose-500/10 text-rose-600 dark:text-rose-400",
};
const UNKNOWN_LEVEL_CLASS = "border-transparent bg-muted text-muted-foreground";

function isKnownLevel(level: string): level is KnownLevel {
  return KNOWN_LEVEL_SET.has(level);
}

function trimToCap(rows: LogRow[], cap: number): LogRow[] {
  if (rows.length <= cap) return rows;
  return rows.slice(rows.length - cap);
}

/** Range of seqs currently retained among `entry` rows (gap rows carry no
 *  seq). `null` when no entry rows are held yet. */
function findSeqBounds(rows: LogRow[]): { min: number; max: number } | null {
  let min: number | undefined;
  let max: number | undefined;
  for (const row of rows) {
    if (row.kind === "entry") {
      if (min === undefined) min = row.seq;
      max = row.seq;
    }
  }
  if (min === undefined || max === undefined) return null;
  return { min, max };
}

interface AppendResult {
  rows: LogRow[];
  /** False for a duplicate replay — `rows` is the same reference as input. */
  changed: boolean;
  /** True when this frame started a brand new stream (collector restart). */
  reset: boolean;
}

function appendLogEntry(prev: LogRow[], data: LogTopicData): AppendResult {
  const entryRow: LogRow = {
    kind: "entry",
    seq: data.seq,
    level: data.level,
    payload: data.payload,
    ts: data.ts,
    // Precomputed once here, not in render — see EntryRow's own comment.
    timeLabel: formatLogTime(data.ts),
  };
  const bounds = findSeqBounds(prev);

  if (!bounds || data.seq > bounds.max) {
    return { rows: [...prev, entryRow], changed: true, reset: false };
  }
  if (data.seq >= bounds.min) {
    // Already covered by what we're holding — a ring replay after a plain
    // reconnect re-sending history we already have. Drop silently.
    return { rows: prev, changed: false, reset: false };
  }
  // Lower than everything we hold, and not covered by the dedup window:
  // the collector restarted and seq numbering began again from a low
  // value. Treat this frame as the start of a brand new stream.
  return { rows: [entryRow], changed: true, reset: true };
}

function formatLogTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface LogsPageProps {
  backendId: number | undefined;
}

export function LogsPage({ backendId }: LogsPageProps) {
  const t = useTranslations("management.logs");

  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [visibleLevels, setVisibleLevels] = useState<Set<KnownLevel>>(
    () => new Set(ALL_LEVELS.filter((l) => l !== "debug")),
  );
  const [topicOffline, setTopicOffline] = useState(false);
  const [autoStick, setAutoStick] = useState(true);
  const [bufferOverflowed, setBufferOverflowed] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gapIdRef = useRef(0);
  // Mirrors `rows`/`autoStick` for the zero-dependency message handler
  // below — see file header comment.
  const rowsRef = useRef<LogRow[]>([]);
  const autoStickRef = useRef(true);

  const handleTopicMessage = useCallback((message: TopicMessage) => {
    if (message.type === "topic-error") {
      setTopicOffline(true);
      return;
    }

    let next: LogRow[];

    if (message.type === "topic-gap") {
      gapIdRef.current += 1;
      next = [
        ...rowsRef.current,
        { kind: "gap", id: gapIdRef.current, dropped: message.dropped },
      ];
    } else {
      const data = message.data as LogTopicData | undefined;
      if (!data || typeof data.seq !== "number") return;
      const result = appendLogEntry(rowsRef.current, data);
      setTopicOffline(false);
      if (!result.changed) return; // duplicate replay — nothing to do
      next = result.rows;
      if (result.reset) setBufferOverflowed(false);
    }

    const sticking = autoStickRef.current;
    const cap = sticking ? SOFT_CAP : HARD_CAP;
    // While paused, only the hard cap evicts — see file header: evicting
    // under the soft cap here would shift the paused user's scroll
    // position with nothing to compensate it.
    if (!sticking && next.length > HARD_CAP) {
      setBufferOverflowed(true);
    }
    const trimmed = trimToCap(next, cap);
    rowsRef.current = trimmed;
    setRows(trimmed);
  }, []);

  const { status: wsStatus } = useTopicSubscription({
    topic: "logs",
    backendId,
    enabled: backendId !== undefined,
    onMessage: handleTopicMessage,
  });
  const wsOffline = wsStatus !== "connected";

  const toggleLevel = useCallback((level: KnownLevel) => {
    setVisibleLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }, []);

  const visibleRows = useMemo(() => {
    return (rows ?? []).filter((row) => {
      if (row.kind === "gap") return true;
      if (isKnownLevel(row.level)) return visibleLevels.has(row.level);
      // Unknown levels are never dropped by the filter.
      return true;
    });
  }, [rows, visibleLevels]);

  // Resume stickiness (scrolled back to bottom, or "back to latest"
  // clicked): trims the paused burst (buffered up to HARD_CAP while
  // paused) back down to the steady-state cap immediately.
  const resumeSticking = useCallback(() => {
    autoStickRef.current = true;
    setAutoStick(true);
    setBufferOverflowed(false);
    const trimmed = trimToCap(rowsRef.current, SOFT_CAP);
    if (trimmed !== rowsRef.current) {
      rowsRef.current = trimmed;
      setRows(trimmed);
    }
  }, []);

  // Measurement-based stickiness — see file header comment for why this
  // can't feedback-loop with the scroll-to-bottom effect below.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom <= 48;
    if (atBottom) {
      if (!autoStickRef.current) resumeSticking();
    } else if (autoStickRef.current) {
      autoStickRef.current = false;
      setAutoStick(false);
    }
  }, [resumeSticking]);

  useEffect(() => {
    if (!autoStick) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleRows, autoStick]);

  const handleBackToLatest = useCallback(() => {
    resumeSticking();
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [resumeSticking]);

  const hasData = rows !== null;
  // Quiet backend (freshly created ring, nothing published yet): once the
  // socket is actually connected, treat "no frames yet" as the empty
  // state, not an indefinite skeleton. Skeleton is reserved for the
  // connecting/initial phase only.
  const stillConnecting = !hasData && !topicOffline && wsStatus !== "connected";

  if (stillConnecting) {
    return <LogsPageSkeleton />;
  }

  if (topicOffline && !hasData) {
    return <OfflineBanner fullPage />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Terminal className="w-5 h-5" />
          {t("title")}
        </h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {ALL_LEVELS.map((level) => {
            const active = visibleLevels.has(level);
            return (
              <button
                key={level}
                type="button"
                aria-pressed={active}
                onClick={() => toggleLevel(level)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  active
                    ? LEVEL_CLASSES[level]
                    : "border-transparent bg-muted text-muted-foreground hover:bg-muted/70",
                )}
              >
                {t(`levels.${level}`)}
              </button>
            );
          })}
        </div>
      </div>

      {/* `topicOffline` (server said unreachable) takes precedence over a
          bare `wsOffline` (our socket to the collector is momentarily
          down) in what the banner says — same treatment as connections-page. */}
      {(topicOffline || wsOffline) && <OfflineBanner reconnecting={!topicOffline} />}
      {!autoStick && bufferOverflowed && <BufferOverflowNotice />}

      <Card className="relative">
        <CardContent className="p-0">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="h-[65vh] min-h-[320px] overflow-y-auto"
          >
            {visibleRows.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">{t("empty")}</div>
            ) : (
              <div className="divide-y divide-border/50">
                {visibleRows.map((row) =>
                  row.kind === "gap" ? (
                    <GapRow key={`gap-${row.id}`} dropped={row.dropped} />
                  ) : (
                    <EntryRow key={row.seq} row={row} />
                  ),
                )}
              </div>
            )}
          </div>

          {!autoStick && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleBackToLatest}
              className="absolute bottom-4 right-4 gap-1.5 shadow-md"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              {t("backToLatest")}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Memoized: with per-line publishes (unlike the 1s-throttled `connections`
// snapshot), an unmemoized row component would re-render every row on
// every single incoming line. Row objects are immutable once appended
// (a duplicate frame returns the very same array reference and never
// reaches a fresh row object; a reset replaces the whole array), so a
// shallow prop comparison correctly skips every row except the ones that
// actually changed. `timeLabel` is precomputed once at append time
// (`appendLogEntry`) rather than formatted here on every render.
const EntryRow = memo(function EntryRow({ row }: { row: Extract<LogRow, { kind: "entry" }> }) {
  const cls = isKnownLevel(row.level) ? LEVEL_CLASSES[row.level] : UNKNOWN_LEVEL_CLASS;
  return (
    <div className="flex items-start gap-2 px-3 py-1.5 font-mono text-xs hover:bg-muted/30">
      <Badge
        variant="outline"
        className={cn(cls, "shrink-0 w-16 justify-center uppercase text-[10px]")}
      >
        {row.level}
      </Badge>
      <span className="shrink-0 text-muted-foreground tabular-nums">{row.timeLabel}</span>
      <span className="flex-1 whitespace-pre-wrap break-all">{row.payload}</span>
    </div>
  );
});

const GapRow = memo(function GapRow({ dropped }: { dropped: number }) {
  const t = useTranslations("management.logs");
  return (
    <div className="flex items-center justify-center px-3 py-1.5 text-xs text-muted-foreground bg-muted/20">
      {t("gapMarker", { count: dropped })}
    </div>
  );
});

function BufferOverflowNotice() {
  const t = useTranslations("management.logs");
  return (
    <div
      role="status"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 flex items-center gap-2"
    >
      <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
      <p className="text-sm text-amber-700 dark:text-amber-300">{t("bufferOverflow")}</p>
    </div>
  );
}

/** Duplicated (not extracted) from connections-page.tsx's `OfflineBanner` —
 *  same visual/i18n pattern; no retry button since the topic subscription
 *  reconnects and self-heals both `topicOffline` and `wsOffline` on its own
 *  next frame. */
function OfflineBanner({ fullPage, reconnecting }: { fullPage?: boolean; reconnecting?: boolean }) {
  const t = useTranslations("management.logs");

  const content = (
    <div
      role="alert"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-center gap-3"
    >
      <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
      <p className="text-sm text-amber-700 dark:text-amber-300">
        {reconnecting ? t("reconnectingBanner") : t("offlineBanner")}
      </p>
    </div>
  );

  if (!fullPage) return content;

  return <div className="flex items-center justify-center min-h-[50vh] p-4">{content}</div>;
}

function LogsPageSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="h-6 w-32 rounded bg-muted/60 animate-pulse" />
        <div className="h-6 w-64 rounded bg-muted/40 animate-pulse" />
      </div>
      <div className="rounded-xl border bg-card p-4 space-y-3">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <div key={i} className="h-4 w-full rounded bg-muted/40 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
