"use client";

/**
 * Live connections table (M1 task 6). `connections` is a *snapshot* topic
 * (m1-contracts.md) — collector throttles it to 1/s and a slow client only
 * ever gets the latest frame, never a backlog. Each frame carries Mihomo's
 * `/connections` response verbatim: `{ connections: [...], downloadTotal,
 * uploadTotal }`.
 *
 * Per-connection up/down rates are not part of that payload — they're
 * derived here by diffing this frame's cumulative `upload`/`download`
 * bytes against the previous frame's, by connection `id`, divided by the
 * actual wall-clock gap between frames (not an assumed fixed cadence,
 * since throttling/network jitter means frames don't always land exactly
 * 1s apart). A connection with no entry in the previous frame (just
 * opened) shows a 0 rate for one tick rather than guessing.
 *
 * Pausing only stops frames from being *applied* — the topic subscription
 * itself stays live (no unsubscribe/resubscribe) and incoming frames while
 * paused are dropped outright, never buffered. Resuming re-syncs from
 * whatever frame arrives next; nothing that arrived during the pause is
 * replayed. This matches the snapshot semantics of the topic: there is no
 * meaningful "catch up" for a table that only ever shows current state.
 *
 * A raw WebSocket reconnect (network blip between browser and collector —
 * distinct from the server pushing `topic-error`) gets the same treatment
 * as pause: `useTopicSubscription`'s `status` is consumed so the rate
 * baseline is dropped the moment the socket leaves `"connected"`, and an
 * inline banner marks the table as stale until a fresh frame lands after
 * reconnect. A server-reported `topic-error` (`topicOffline`) always wins
 * over a bare `wsOffline` in what the banner says — the server explicitly
 * telling us the backend is unreachable is more specific than "our socket
 * to the collector happens to be down right now".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Link2,
  Pause,
  Play,
  XCircle,
} from "lucide-react";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn, formatBytes, formatDuration } from "@/lib/utils";
import { useKillConnection } from "@/hooks/api/use-management";
import { useTopicSubscription, type TopicMessage } from "@/lib/management-ws";

/** Mihomo connection object (passthrough) — only the fields this page reads
 *  are named, everything else survives via the index signature since the
 *  collector doesn't validate/strip Mihomo's response shape. */
interface MihomoConnectionMetadata {
  host?: string;
  sourceIP?: string;
  destinationIP?: string;
  sourcePort?: string;
  destinationPort?: string;
  network?: string;
  type?: string;
  [key: string]: unknown;
}

interface MihomoConnection {
  id: string;
  metadata: MihomoConnectionMetadata;
  upload: number;
  download: number;
  start: string;
  /** Exit-first as delivered by Mihomo — displayed in that same order, no
   *  reversal. */
  chains: string[];
  rule: string;
  rulePayload?: string;
  [key: string]: unknown;
}

interface ConnectionsSnapshotData {
  connections: MihomoConnection[];
  downloadTotal?: number;
  uploadTotal?: number;
}

/** A connection augmented with this-frame rates, computed by the message
 *  handler below (never sent by the server). */
interface ConnectionRow extends MihomoConnection {
  downRate: number;
  upRate: number;
}

interface PrevFrame {
  byId: Map<string, { upload: number; download: number }>;
  timestamp: number;
}

// Module scope, per the package's own "keep static inputs outside render"
// guidance: `features` and the column helper it types don't depend on
// anything component-local, so building them once avoids reconstructing the
// feature registry on every render.
const tableFeaturesConfig = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});
const columnHelper = createColumnHelper<typeof tableFeaturesConfig, ConnectionRow>();

interface ConnectionsPageProps {
  backendId: number | undefined;
}

export function ConnectionsPage({ backendId }: ConnectionsPageProps) {
  const t = useTranslations("management.connections");
  const killConnection = useKillConnection(backendId);

  const [connections, setConnections] = useState<ConnectionRow[] | null>(null);
  const [totals, setTotals] = useState({ downloadTotal: 0, uploadTotal: 0 });
  const [paused, setPaused] = useState(false);
  const [topicOffline, setTopicOffline] = useState(false);
  const [search, setSearch] = useState("");
  const [killingIds, setKillingIds] = useState<Set<string>>(new Set());

  const prevFrameRef = useRef<PrevFrame | null>(null);

  const handleTopicMessage = useCallback(
    (message: TopicMessage) => {
      if (message.type === "topic-error") {
        setTopicOffline(true);
        return;
      }
      if (message.type === "topic-gap") {
        // `connections` is a snapshot topic, not an append one — gap
        // accounting (m1-contracts.md) only applies to `logs`/`delay`.
        return;
      }

      // Ignore the frame entirely while paused — see file header comment.
      if (paused) return;

      const data = message.data as ConnectionsSnapshotData | undefined;
      if (!data) return;
      // mihomo serializes zero active connections as `connections: null`
      // (Go nil slice), not `[]` — such frames are still valid snapshots
      // (totals included). Dropping them keeps `connections` at its initial
      // `null` forever, so an idle backend never leaves the skeleton.
      const frameConnections = Array.isArray(data.connections) ? data.connections : [];

      const now = Date.now();
      const prev = prevFrameRef.current;
      const rows: ConnectionRow[] = frameConnections.map((conn) => {
        const prevEntry = prev?.byId.get(conn.id);
        let downRate = 0;
        let upRate = 0;
        if (prevEntry) {
          const intervalSeconds = (now - prev!.timestamp) / 1000;
          if (intervalSeconds > 0) {
            downRate = Math.max(0, (conn.download - prevEntry.download) / intervalSeconds);
            upRate = Math.max(0, (conn.upload - prevEntry.upload) / intervalSeconds);
          }
        }
        return { ...conn, downRate, upRate };
      });

      prevFrameRef.current = {
        byId: new Map(frameConnections.map((c) => [c.id, { upload: c.upload, download: c.download }])),
        timestamp: now,
      };

      setConnections(rows);
      setTotals({
        downloadTotal: data.downloadTotal ?? 0,
        uploadTotal: data.uploadTotal ?? 0,
      });
      setTopicOffline(false);
    },
    [paused],
  );

  const { status: wsStatus } = useTopicSubscription({
    topic: "connections",
    backendId,
    enabled: backendId !== undefined,
    onMessage: handleTopicMessage,
  });

  // `wsStatus` is derived state from the hook's own `useState`, not owned
  // here — `wsOffline` just reads it, no separate flag to fight with
  // `topicOffline`. Only the ref-clearing below is a side effect worth an
  // effect: the same rebaseline `handleTogglePause` does on pause-entry,
  // triggered here by the socket itself leaving `"connected"` (covers
  // reconnects `handleTogglePause` can't see, since the subscription stays
  // live across those). Runs once per status transition, not per render,
  // and clearing an already-null ref on a multi-hop reconnect sequence
  // ("connecting" -> "error" -> "connecting" -> "connected") is harmless.
  useEffect(() => {
    if (wsStatus !== "connected") {
      prevFrameRef.current = null;
    }
  }, [wsStatus]);
  const wsOffline = wsStatus !== "connected";

  const handleTogglePause = useCallback(() => {
    setPaused((prev) => {
      const next = !prev;
      if (next) {
        // Entering pause: drop the rate baseline. Without this, the first
        // frame applied after resume would diff against a frame that's
        // potentially minutes old, dividing that whole accumulated byte
        // delta by the wall-clock gap and reporting a fake "average rate
        // over the pause" for one tick instead of the 0 this file's header
        // comment already promises for any connection with no fresh
        // baseline.
        prevFrameRef.current = null;
      }
      return next;
    });
  }, []);

  // Kill is fire-and-forget from the row's point of view: success removes
  // nothing locally, the connection just stops appearing once it's absent
  // from the next `connections` frame. No optimistic row removal — the
  // topic is the single source of truth for what's still open, and a kill
  // that raced a connection's own natural close would otherwise have
  // nothing to "undo". Failure already surfaces as a toast from
  // `useKillConnection` itself (use-management.ts); `killingIds` here only
  // drives this row's own spinner/disabled state.
  const handleKill = useCallback(
    (connId: string) => {
      setKillingIds((prev) => new Set(prev).add(connId));
      killConnection.mutate(connId, {
        onSettled: () => {
          setKillingIds((prev) => {
            if (!prev.has(connId)) return prev;
            const next = new Set(prev);
            next.delete(connId);
            return next;
          });
        },
      });
    },
    // `killConnection.mutate` (not the whole `killConnection` object) —
    // `useMutation` returns a fresh object every render, which would
    // otherwise rebuild `columns` below (and thus the table) on every
    // ~1s frame; `.mutate`'s identity is stable across renders in React
    // Query v5.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [killConnection.mutate],
  );

  // `columnHelper.columns([...])` (not a bare array) preserves each
  // column's own `TValue` instead of widening the array to a union TS can't
  // reassign back to a single `ColumnDef<..., unknown>[]` — the documented
  // v9 fix for the classic "mixed accessor value types" inference failure.
  // Every accessor column gets an explicit `sortFn` (function, not a string
  // name) rather than relying on v9's default: an unset `sortFn` looks up
  // `column.table._rowModelFns.sortFns[undefined]`, which is always a miss
  // and logs a dev-mode console.warn per column, since no `sortFns` registry
  // is registered in `tableFeaturesConfig` above (nothing here ever
  // references a sort function by string name, so there's nothing to
  // register it for).
  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor((row) => row.metadata?.host || row.metadata?.destinationIP || "", {
          id: "host",
          header: t("columns.host"),
          sortFn: sortFn_alphanumeric,
          cell: (info) => (
            <span className="font-mono text-xs block max-w-[220px] truncate" title={info.getValue()}>
              {info.getValue() || "-"}
            </span>
          ),
        }),
        columnHelper.accessor((row) => (row.chains ?? []).join(" → "), {
          id: "chains",
          header: t("columns.chains"),
          sortFn: sortFn_alphanumeric,
          cell: (info) => (
            <span
              className="text-xs text-muted-foreground block max-w-[200px] truncate"
              title={info.getValue()}
            >
              {info.getValue() || "-"}
            </span>
          ),
        }),
        columnHelper.accessor(
          (row) => (row.rulePayload ? `${row.rule} (${row.rulePayload})` : row.rule || ""),
          {
            id: "rule",
            header: t("columns.rule"),
            sortFn: sortFn_alphanumeric,
            cell: (info) => (
              <span className="text-xs block max-w-[180px] truncate" title={info.getValue()}>
                {info.getValue() || "-"}
              </span>
            ),
          },
        ),
        columnHelper.accessor("downRate", {
          id: "downRate",
          header: t("columns.downRate"),
          sortFn: sortFn_basic,
          cell: (info) => (
            <span className="tabular-nums text-xs text-blue-500 dark:text-blue-400 whitespace-nowrap">
              {formatBytes(info.getValue())}/s
            </span>
          ),
        }),
        columnHelper.accessor("upRate", {
          id: "upRate",
          header: t("columns.upRate"),
          sortFn: sortFn_basic,
          cell: (info) => (
            <span className="tabular-nums text-xs text-purple-500 dark:text-purple-400 whitespace-nowrap">
              {formatBytes(info.getValue())}/s
            </span>
          ),
        }),
        columnHelper.accessor((row) => row.download + row.upload, {
          id: "traffic",
          header: t("columns.traffic"),
          sortFn: sortFn_basic,
          cell: (info) => (
            <span className="tabular-nums text-xs whitespace-nowrap">{formatBytes(info.getValue())}</span>
          ),
        }),
        columnHelper.accessor((row) => new Date(row.start).getTime(), {
          id: "start",
          header: t("columns.start"),
          sortFn: sortFn_basic,
          cell: (info) => (
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {formatDuration(info.row.original.start)}
            </span>
          ),
        }),
        columnHelper.accessor(
          (row) => `${row.metadata?.sourceIP || ""}:${row.metadata?.sourcePort || ""}`,
          {
            id: "source",
            header: t("columns.source"),
            sortFn: sortFn_alphanumeric,
            cell: (info) => (
              <span className="font-mono text-xs whitespace-nowrap">{info.getValue()}</span>
            ),
          },
        ),
        columnHelper.display({
          id: "actions",
          header: t("columns.actions"),
          cell: (info) => (
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => handleKill(info.row.original.id)}
              disabled={killingIds.has(info.row.original.id)}
              aria-label={t("kill")}
              title={t("kill")}
            >
              <XCircle className="h-4 w-4" />
            </Button>
          ),
        }),
      ]),
    [t, handleKill, killingIds],
  );

  // Client-side free-text pre-filter over host/destinationIP/sourceIP,
  // applied before the rows ever reach the table — simpler than wiring up
  // react-table's own filtered row model for a single search box with no
  // per-column filter UI, and connection counts are ~10^3 at most so a
  // plain array filter on every render is cheap.
  const filteredConnections = useMemo(() => {
    const rows = connections ?? [];
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((c) => {
      const host = c.metadata?.host?.toLowerCase() ?? "";
      const destIP = c.metadata?.destinationIP?.toLowerCase() ?? "";
      const srcIP = c.metadata?.sourceIP?.toLowerCase() ?? "";
      return host.includes(query) || destIP.includes(query) || srcIP.includes(query);
    });
  }, [connections, search]);

  const table = useTable({
    data: filteredConnections,
    columns,
    features: tableFeaturesConfig,
    // Mihomo's connection `id` is already a stable, unique identifier — use
    // it as the row id instead of the default array-index fallback. Rows
    // reorder every frame (sorted by rate) and are replaced wholesale on
    // every tick, so an index-keyed row would make React reuse DOM across
    // unrelated connections instead of tracking each connection's own row.
    getRowId: (row) => row.id,
    // No `getFilteredRowModel`/`filteredRowModel` feature slot — filtering
    // is handled by the pre-filter above.
    initialState: {
      sorting: [{ id: "downRate", desc: true }],
    },
  });

  const totalDownRate = useMemo(
    () => (connections ?? []).reduce((sum, c) => sum + c.downRate, 0),
    [connections],
  );
  const totalUpRate = useMemo(
    () => (connections ?? []).reduce((sum, c) => sum + c.upRate, 0),
    [connections],
  );

  const hasData = connections !== null;

  if (!hasData && !topicOffline) {
    return <ConnectionsPageSkeleton />;
  }

  if (topicOffline && !hasData) {
    return <OfflineBanner fullPage />;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Link2 className="w-5 h-5" />
        {t("title")}
      </h2>

      {/* `topicOffline` (server said unreachable) takes precedence over a
          bare `wsOffline` (our socket to the collector is momentarily
          down) in what the banner says — see file header comment. */}
      {(topicOffline || wsOffline) && <OfflineBanner reconnecting={!topicOffline} />}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border bg-card shadow-xs p-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
          <Stat label={t("stats.count")} value={String(connections?.length ?? 0)} />
          <Stat
            label={t("stats.downRate")}
            value={`${formatBytes(totalDownRate)}/s`}
            valueClassName="text-blue-500 dark:text-blue-400"
          />
          <Stat
            label={t("stats.upRate")}
            value={`${formatBytes(totalUpRate)}/s`}
            valueClassName="text-purple-500 dark:text-purple-400"
          />
          <Stat label={t("stats.downloadTotal")} value={formatBytes(totals.downloadTotal)} />
          <Stat label={t("stats.uploadTotal")} value={formatBytes(totals.uploadTotal)} />
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <Input
            placeholder={t("searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full sm:w-[220px] bg-secondary/50 border-0"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 shrink-0"
            onClick={handleTogglePause}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? t("resume") : t("pause")}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {filteredConnections.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {search ? t("noResults") : t("empty")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => {
                      const canSort = header.column.getCanSort();
                      const sorted = header.column.getIsSorted();
                      return (
                        <TableHead
                          key={header.id}
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(canSort && "cursor-pointer select-none")}
                        >
                          <span className="inline-flex items-center">
                            <table.FlexRender header={header} />
                            {canSort &&
                              (sorted === "asc" ? (
                                <ArrowUp className="ml-1 h-3 w-3 text-primary" />
                              ) : sorted === "desc" ? (
                                <ArrowDown className="ml-1 h-3 w-3 text-primary" />
                              ) : (
                                <ArrowUpDown className="ml-1 h-3 w-3 text-muted-foreground" />
                              ))}
                          </span>
                        </TableHead>
                      );
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={cn("font-medium tabular-nums", valueClassName)}>{value}</span>
    </div>
  );
}

/** Duplicated (not extracted) from `groups-page.tsx`'s `OfflineBanner`: same
 *  visual/i18n pattern, but no retry button — that page's banner retries a
 *  REST query, this page has none; the topic subscription already
 *  reconnects and self-heals both `topicOffline` and (via `wsStatus`)
 *  `wsOffline` on its own next data frame / reconnect.
 *
 *  `reconnecting` swaps in a lighter message for a bare WebSocket blip
 *  (`wsOffline` with no server-reported `topic-error`) — same visual
 *  treatment, since it's still "the table you're looking at is stale,"
 *  but worded as transient rather than as a backend-reachability problem. */
function OfflineBanner({
  fullPage,
  reconnecting,
}: {
  fullPage?: boolean;
  reconnecting?: boolean;
}) {
  const t = useTranslations("management.connections");

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

function ConnectionsPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-6 w-32 rounded bg-muted/60 animate-pulse" />
      <div className="h-16 w-full rounded-xl bg-muted/40 animate-pulse" />
      <div className="rounded-xl border bg-card shadow-xs p-4 space-y-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-8 w-full rounded bg-muted/40 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
