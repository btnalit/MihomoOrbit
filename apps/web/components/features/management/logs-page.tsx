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
 * applied whenever the user is on page 1 (viewing latest — the pagination
 * equivalent of the old scroll-based "stuck to bottom"), a second bound
 * over the server's 500-entry ring. While viewing an older page (page !==
 * 1), evicting under the soft cap would shift which entries land on every
 * page below the newest — the reversed list's tail (oldest entries) is
 * exactly what a later page renders, so trimming it out from under a
 * paged-back user would silently change what's on their screen. Only
 * `HARD_CAP` (2000) evicts on an older page, a safety valve rather than a
 * steady-state bound; returning to page 1 trims the buffered burst back
 * down to `SOFT_CAP` immediately. Hitting `HARD_CAP` on an older page
 * surfaces an inline notice that clears back on page 1.
 *
 * The level filter is local/client-only — it never unsubscribes or asks
 * the server to stop sending a level. All levels (including debug, hidden
 * by default since the upstream tail is debug-level) are always received,
 * stored, and counted against the caps above; only rendering is filtered.
 * Unknown levels (anything outside debug/info/warning/error) always
 * render, regardless of filter chip state.
 *
 * Newest-first display + pagination: internal storage stays oldest-first
 * (the append/dedup/cap logic above is seq-contract-critical and
 * unchanged) — reversal to newest-first happens only in a memoized
 * render-time derivation, then the reversed+level-filtered list is
 * paginated the same way connections-page paginates its sorted rows. Page
 * 1 always shows the newest entries, so new frames arriving while on page
 * 1 naturally appear at the top with no scroll bookkeeping needed.
 *
 * `rowsRef`/`pageRef` mirror the corresponding state so
 * `handleTopicMessage` (a stable, zero-dependency callback — worth keeping
 * stable since it fires on every single log line, unlike the throttled
 * `connections` snapshot) can read the latest accumulated rows and the
 * user's current page without depending on render-scoped state;
 * `EntryRow`/`GapRow` are memoized so an appended line only renders itself,
 * not the other ~1000 rows already on screen.
 */

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useTopicSubscription, type TopicMessage } from "@/lib/management-ws";
import { PaginationBar } from "./pagination-bar";
import type { PageSize } from "@/lib/stats-utils";

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
//
// Invariant shared with the server (ws-relay.ts's LOG_RING_CAPACITY=500 and
// topic-hub.ts's APPEND_QUEUE_LIMIT=200): SOFT_CAP must stay >=
// LOG_RING_CAPACITY + APPEND_QUEUE_LIMIT, or a ring replay plus a lagging
// client's queued backlog could exceed what this page retains, and
// appendLogEntry's seq-range dedup (findSeqBounds) would misread the
// resulting gap as a brand-new stream and spuriously reset the view.
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

/** `nextGapId` mints the same monotonic id space `handleTopicMessage` uses
 *  for server-reported `topic-gap` frames (`gapIdRef`), so React keys never
 *  collide between the two gap sources. */
function appendLogEntry(prev: LogRow[], data: LogTopicData, nextGapId: () => number): AppendResult {
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
    // Forward tail-append (including the very first frame of a session,
    // where `bounds` is null and there's nothing to compare against). A gap
    // (seq > max+1) means frames were lost in-stream — not a reset, the
    // collector never restarted — and must be surfaced, unless it was
    // already reported: a server `topic-gap` frame (handled separately in
    // handleTopicMessage) appends its own gap row but carries no seq, so
    // `findSeqBounds` — which only tracks `entry` rows — still reports
    // `bounds.max` as the last entry *before* that gap. The very next entry
    // frame would otherwise look like a second, unrelated forward jump and
    // double-report the same loss.
    const gapSize = bounds ? data.seq - bounds.max - 1 : 0;
    const lastRow = prev[prev.length - 1];
    const alreadyReported = lastRow?.kind === "gap";
    const rows =
      gapSize > 0 && !alreadyReported
        ? [...prev, { kind: "gap", id: nextGapId(), dropped: gapSize } as LogRow, entryRow]
        : [...prev, entryRow];
    return { rows, changed: true, reset: false };
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
  const [bufferOverflowed, setBufferOverflowed] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);

  const gapIdRef = useRef(0);
  // Mirrors `rows`/`page` for the zero-dependency message handler below —
  // see file header comment.
  const rowsRef = useRef<LogRow[]>([]);
  const pageRef = useRef(1);

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
      const result = appendLogEntry(rowsRef.current, data, () => (gapIdRef.current += 1));
      setTopicOffline(false);
      if (!result.changed) return; // duplicate replay — nothing to do
      next = result.rows;
      if (result.reset) {
        setBufferOverflowed(false);
        // Collector restart: the list was just replaced wholesale, so any
        // page the user was on no longer refers to anything. Without this,
        // the derived clamp shows page 1 while raw `page`/`pageRef` keep the
        // old number — the view then silently jumps back once enough new
        // lines accumulate, and the SOFT_CAP "on latest page" gate below
        // stays disengaged.
        pageRef.current = 1;
        setPage(1);
      }
    }

    const onLatestPage = pageRef.current === 1;
    const cap = onLatestPage ? SOFT_CAP : HARD_CAP;
    // On an older page, only the hard cap evicts — see file header: evicting
    // under the soft cap here would shift which entries land on later pages
    // out from under a paged-back user.
    if (!onLatestPage && next.length > HARD_CAP) {
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

  // Returning to page 1 (the "on latest" state, replacing the old
  // scroll-based autoStick) immediately trims any burst buffered up to
  // HARD_CAP while the user was on a later page back down to the
  // steady-state SOFT_CAP, and clears the overflow notice — mirrors the old
  // resumeSticking's synchronous trim, called directly from the handlers
  // below (an event handler, not a reactive effect) wherever navigation
  // lands back on page 1.
  const trimToLatestIfNeeded = useCallback(() => {
    setBufferOverflowed(false);
    const trimmed = trimToCap(rowsRef.current, SOFT_CAP);
    if (trimmed !== rowsRef.current) {
      rowsRef.current = trimmed;
      setRows(trimmed);
    }
  }, []);

  // Level filter, page size, and page navigation all keep `pageRef` in sync
  // alongside the state setter (not via a separate effect) so the
  // zero-dependency `handleTopicMessage` above never reads a stale page
  // number between a click and the next render.
  const toggleLevel = useCallback(
    (level: KnownLevel) => {
      setVisibleLevels((prev) => {
        const next = new Set(prev);
        if (next.has(level)) {
          next.delete(level);
        } else {
          next.add(level);
        }
        return next;
      });
      // Filtering changes what "page 1" contains, same as connections-page's
      // search — reset to page 1 rather than leaving the user on a page
      // whose contents just shifted under them.
      pageRef.current = 1;
      setPage(1);
      trimToLatestIfNeeded();
    },
    [trimToLatestIfNeeded],
  );

  const handlePageChange = useCallback(
    (next: number) => {
      pageRef.current = next;
      setPage(next);
      if (next === 1) trimToLatestIfNeeded();
    },
    [trimToLatestIfNeeded],
  );

  const handlePageSizeChange = useCallback(
    (size: PageSize) => {
      setPageSize(size);
      pageRef.current = 1;
      setPage(1);
      trimToLatestIfNeeded();
    },
    [trimToLatestIfNeeded],
  );

  // Newest-first is a render-time derivation over the oldest-first storage
  // array (`rows`) — see file header comment. Reversing first and filtering
  // second keeps a gap row's position relative to its two neighboring
  // entries intact (it's just another element of the same array).
  const reversedRows = useMemo(() => (rows ? [...rows].reverse() : []), [rows]);

  const visibleRows = useMemo(() => {
    return reversedRows.filter((row) => {
      if (row.kind === "gap") return true;
      if (isKnownLevel(row.level)) return visibleLevels.has(row.level);
      // Unknown levels are never dropped by the filter.
      return true;
    });
  }, [reversedRows, visibleLevels]);

  // Paginate the reversed+filtered list — same manual-slice idiom as
  // connections-page. `effectivePage` is derived at render time rather than
  // written back into `page` state, so a shrinking `totalPages` (HARD_CAP
  // eviction while on an older page) never fights the explicit resets in
  // `toggleLevel`/`handlePageSizeChange` above.
  const totalItems = visibleRows.length;
  const totalPages = totalItems > 0 ? Math.max(1, Math.ceil(totalItems / pageSize)) : 0;
  const effectivePage = totalPages > 0 ? Math.min(page, totalPages) : 1;
  const pageRows = visibleRows.slice(
    (effectivePage - 1) * pageSize,
    effectivePage * pageSize,
  );

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
    <div className="space-y-6">
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
      {/* `effectivePage` (not raw `page`) — if a clamp already put the view
          back on page 1, the notice shouldn't linger for a stale page
          number the user didn't explicitly navigate away from. */}
      {effectivePage !== 1 && bufferOverflowed && <BufferOverflowNotice />}

      <Card>
        <CardContent className="p-0">
          {visibleRows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {/* Distinguish "nothing has arrived yet" from "the level
                  filter hid everything we have" — `rows` (unfiltered) vs
                  `visibleRows` (filtered) diverging means the latter. */}
              {rows && rows.length > 0 ? t("emptyFiltered") : t("empty")}
            </div>
          ) : (
            <>
              <div className="divide-y divide-border/50">
                {pageRows.map((row) =>
                  row.kind === "gap" ? (
                    <GapRow key={`gap-${row.id}`} dropped={row.dropped} />
                  ) : (
                    <EntryRow key={row.seq} row={row} />
                  ),
                )}
              </div>
              <PaginationBar
                page={effectivePage}
                pageSize={pageSize}
                totalItems={totalItems}
                totalPages={totalPages}
                onPageChange={handlePageChange}
                onPageSizeChange={handlePageSizeChange}
                pageWord={t("pagination.page")}
              />
            </>
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
  const t = useTranslations("management.logs");
  const known = isKnownLevel(row.level);
  const cls = known ? LEVEL_CLASSES[row.level as KnownLevel] : UNKNOWN_LEVEL_CLASS;
  // Unknown levels (anything the upstream might add later, outside the four
  // documented ones) have no translation key — fall back to the raw string
  // rather than a missing-key error.
  const label = known ? t(`levels.${row.level as KnownLevel}`) : row.level;
  return (
    <div className="flex items-start gap-2 px-3 py-1.5 font-mono text-xs hover:bg-muted/30">
      <Badge
        variant="outline"
        className={cn(cls, "shrink-0 w-16 justify-center uppercase text-[10px]")}
      >
        {label}
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
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="h-6 w-32 rounded bg-muted/60 animate-pulse" />
        <div className="h-6 w-64 rounded bg-muted/40 animate-pulse" />
      </div>
      <div className="rounded-xl border bg-card shadow-xs p-4 space-y-3">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <div key={i} className="h-4 w-full rounded bg-muted/40 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
