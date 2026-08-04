"use client";

import React, { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceArea,
} from "recharts";
import type { TooltipContentProps } from "recharts";
import { Activity, Clock, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { BackendHealthHistory, BackendHealthPoint } from "@/lib/api";

type HealthStatus = "healthy" | "unhealthy" | "unknown";

// ─── Latency thresholds ──────────────────────────────────────────────────────
const LATENCY_WARN_MS = 300;  // amber
const LATENCY_CRIT_MS = 1000; // red

type LatencyTier = "normal" | "warning" | "critical";

function getLatencyTier(ms: number | null): LatencyTier {
  if (ms === null) return "normal";
  if (ms >= LATENCY_CRIT_MS) return "critical";
  if (ms >= LATENCY_WARN_MS) return "warning";
  return "normal";
}

const TIER_STROKE: Record<LatencyTier, string> = {
  normal:   "#10b981",
  warning:  "#f59e0b",
  critical: "#ef4444",
};

const TIER_TEXT: Record<LatencyTier, string> = {
  normal:   "text-emerald-500",
  warning:  "text-amber-500",
  critical: "text-rose-500",
};

// ─── helpers ────────────────────────────────────────────────────────────────

function toMinuteKey(iso: string): string {
  return iso.slice(0, 16);
}

function formatLabel(cursor: Date, spanMs: number): string {
  if (spanMs <= 48 * 3_600_000) {
    return cursor.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  if (spanMs <= 7 * 86_400_000) {
    return cursor.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return cursor.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface Slot {
  time: string;
  timeLabel: string;
  status: HealthStatus | "gap";
  /** null breaks the line (gap / outage) */
  latency: number | null;
  /** always 1 (online) or null (offline/gap) — used when no latency data available */
  online: number | null;
  latency_ms: number | null;
  gateway_latency_ms: number | null;
  server_latency_ms: number | null;
  message: string | null;
}

function buildSlots(
  from: Date,
  to: Date,
  points: BackendHealthPoint[],
  bucketMinutes: number,
): Slot[] {
  const lookup = new Map<string, BackendHealthPoint>();
  for (const p of points) {
    lookup.set(toMinuteKey(p.time), p);
  }

  const slots: Slot[] = [];
  const cursor = new Date(from);
  const spanMs = to.getTime() - from.getTime();

  while (cursor <= to) {
    const bucketStart = cursor.toISOString().slice(0, 16);

    const bucketPoints: BackendHealthPoint[] = [];
    const tmp = new Date(cursor);
    for (let m = 0; m < bucketMinutes; m++) {
      const key = tmp.toISOString().slice(0, 16);
      const pt = lookup.get(key);
      if (pt) bucketPoints.push(pt);
      tmp.setMinutes(tmp.getMinutes() + 1);
    }

    const timeLabel = formatLabel(new Date(cursor), spanMs);

    if (bucketPoints.length === 0) {
      slots.push({
        time: bucketStart,
        timeLabel,
        status: "gap",
        latency: null,
        online: null,
        latency_ms: null,
        gateway_latency_ms: null,
        server_latency_ms: null,
        message: null,
      });
    } else {
      const hasUnhealthy = bucketPoints.some((p) => p.status === "unhealthy");
      const hasUnknown   = bucketPoints.some((p) => p.status === "unknown");
      const status: HealthStatus = hasUnhealthy ? "unhealthy" : hasUnknown ? "unknown" : "healthy";

      const gatewayLats = bucketPoints
        .filter((p) => p.latency_ms !== null)
        .map((p) => p.latency_ms as number);
      const avgGatewayLatency = gatewayLats.length > 0
        ? Math.round(gatewayLats.reduce((a, b) => a + b, 0) / gatewayLats.length)
        : null;

      const serverLats = bucketPoints
        .filter((p) => p.server_latency_ms !== null)
        .map((p) => p.server_latency_ms as number);
      const avgServerLatency = serverLats.length > 0
        ? Math.round(serverLats.reduce((a, b) => a + b, 0) / serverLats.length)
        : null;

      const avgLatency = avgGatewayLatency !== null ? avgGatewayLatency : avgServerLatency;

      const lastMsg = bucketPoints[bucketPoints.length - 1].message ?? null;

      slots.push({
        time: bucketStart,
        timeLabel,
        status,
        latency: status === "healthy" ? avgLatency : null,
        online:  status === "healthy" ? 1 : null,
        latency_ms: avgLatency,
        gateway_latency_ms: status === "healthy" ? avgGatewayLatency : null,
        server_latency_ms: status === "healthy" ? avgServerLatency : null,
        message: lastMsg,
      });
    }

    cursor.setMinutes(cursor.getMinutes() + bucketMinutes);
  }

  return slots;
}

/**
 * Round a latency max value up to a human-friendly "nice" number with ~30%
 * headroom.  Examples: 2→5, 6→10, 20→50, 80→150, 300→500, 1500→2000.
 */
function niceLatencyMax(maxVal: number): number {
  if (maxVal <= 0) return 10;
  const headroom = maxVal * 1.3;
  const magnitude = Math.pow(10, Math.floor(Math.log10(headroom)));
  const normalized = headroom / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function resolveGapSlots(slots: Slot[]): Slot[] {
  const firstData = slots.findIndex((s) => s.status !== "gap");
  if (firstData === -1) return slots;

  let lastData = -1;
  for (let i = slots.length - 1; i >= 0; i--) {
    if (slots[i].status !== "gap") { lastData = i; break; }
  }

  return slots.map((s, i) => {
    if (s.status !== "gap") return s;
    if (i > firstData && i < lastData) return { ...s, status: "unhealthy" as const };
    return s;
  });
}

function buildRefSpans(
  slots: Slot[],
): Array<{ x1: string; x2: string; type: "unhealthy" | "unknown" | "gap" }> {
  const spans: ReturnType<typeof buildRefSpans> = [];
  let spanStart: string | null = null;
  let spanType: "unhealthy" | "unknown" | "gap" | null = null;

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const isProblematic = s.status !== "healthy";

    if (isProblematic && spanStart === null) {
      spanStart = s.time;
      spanType = s.status as "unhealthy" | "unknown" | "gap";
    } else if (!isProblematic && spanStart !== null) {
      spans.push({ x1: spanStart, x2: slots[i - 1].time, type: spanType! });
      spanStart = null;
      spanType = null;
    } else if (isProblematic && spanType !== null && s.status !== spanType) {
      spans.push({ x1: spanStart!, x2: slots[i - 1].time, type: spanType });
      spanStart = s.time;
      spanType = s.status as "unhealthy" | "unknown" | "gap";
    }
  }
  if (spanStart !== null) {
    spans.push({ x1: spanStart, x2: slots[slots.length - 1].time, type: spanType! });
  }
  return spans;
}


// ─── component ──────────────────────────────────────────────────────────────

interface BackendHealthChartProps {
  history: BackendHealthHistory;
  from: Date;
  to: Date;
  bucketMinutes?: number;
}

export function BackendHealthChart({
  history,
  from,
  to,
  bucketMinutes = 1,
}: BackendHealthChartProps) {
  const t = useTranslations("health");
  const spanMs = to.getTime() - from.getTime();

  const slots = useMemo(
    () => buildSlots(from, to, history.points, bucketMinutes),
    [from, to, history.points, bucketMinutes],
  );

  const refSpans = useMemo(() => buildRefSpans(resolveGapSlots(slots)), [slots]);

  const labelMap = useMemo(
    () => new Map(slots.map((s) => [s.time, s.timeLabel])),
    [slots],
  );

  const stats = useMemo(() => {
    const checked = slots.filter((s) => s.status !== "gap");
    const healthy = checked.filter((s) => s.status === "healthy").length;
    const uptimePct = checked.length > 0 ? (healthy / checked.length) * 100 : null;
    const lats = checked
      .filter((s) => s.latency_ms !== null)
      .map((s) => s.latency_ms as number);
    const avgLatency = lats.length > 0
      ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length)
      : null;
    const maxLatency = lats.length > 0 ? Math.max(...lats) : null;
    const gaps = slots.filter((s) => s.status === "gap").length;
    return { uptimePct, avgLatency, maxLatency, gaps };
  }, [slots]);

  const hasGatewayLatency = useMemo(
    () => slots.some((s) => s.gateway_latency_ms !== null),
    [slots],
  );
  const hasServerLatency = useMemo(
    () => slots.some((s) => s.server_latency_ms !== null),
    [slots],
  );
  const hasLatency = hasGatewayLatency || hasServerLatency;

  const dataKey = hasLatency ? "latency" : "online";

  // ── Latency-based coloring ──────────────────────────────────────────────────
  const latencyDomainMax = useMemo(() => {
    if (!hasLatency) return null;
    const lats = slots
      .flatMap((s) => [s.gateway_latency_ms, s.server_latency_ms])
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (lats.length === 0) return null;
    return niceLatencyMax(Math.max(...lats));
  }, [hasLatency, slots]);

  // Tier is driven by max latency in the visible data
  const latencyTier: LatencyTier = getLatencyTier(stats.maxLatency);
  const gatewayStrokeColor = TIER_STROKE[latencyTier];
  const serverStrokeColor = "#3b82f6";
  const strokeColor = hasLatency
    ? (hasGatewayLatency ? gatewayStrokeColor : serverStrokeColor)
    : "#10b981";



  const avgLatencyTier: LatencyTier = getLatencyTier(stats.avgLatency);
  const maxLatencyTier: LatencyTier = getLatencyTier(stats.maxLatency);

  // ── Status ──────────────────────────────────────────────────────────────────
  const currentStatus =
    history.points.length > 0
      ? history.points[history.points.length - 1].status
      : "unknown";

  const statusDotClass =
    currentStatus === "healthy"
      ? "bg-emerald-500"
      : currentStatus === "unhealthy"
        ? "bg-rose-500"
        : "bg-slate-400";

  // ── Tooltip ────────────────────────────────────────────────────────────────
  const CustomTooltip = React.useCallback(
    ({ active, payload }: TooltipContentProps) => {
      if (!active || !payload?.length) return null;
      const slot = payload[0].payload as Slot;

      const slotDate = new Date(
        slot.time.endsWith("Z") ? slot.time : slot.time + "Z",
      );
      const tooltipTitle =
        spanMs > 7 * 86_400_000
          ? slotDate.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          : slotDate.toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });

      const statusLabel =
        slot.status === "healthy"
          ? t("statusHealthy")
          : slot.status === "unhealthy"
            ? t("statusUnhealthy")
            : slot.status === "unknown"
              ? t("statusUnknown")
              : t("noData");

      const statusClass =
        slot.status === "healthy"
          ? "text-emerald-500"
          : slot.status === "unhealthy"
            ? "text-rose-500"
            : "text-slate-400";

      return (
        <div className="bg-popover border border-border rounded-lg p-3 shadow-lg text-xs space-y-1 min-w-[130px]">
          <p className="text-muted-foreground font-medium">{tooltipTitle}</p>
          <p className={cn("font-semibold", statusClass)}>{statusLabel}</p>
          {slot.gateway_latency_ms !== null && (
            <p className="flex items-center gap-1" style={{ color: gatewayStrokeColor }}>
              <Clock className="w-3 h-3" />
              <span>{t("gatewayLatency")}:</span>
              <span className="tabular-nums font-medium">{slot.gateway_latency_ms}ms</span>
            </p>
          )}
          {slot.server_latency_ms !== null && (
            <p className="flex items-center gap-1" style={{ color: serverStrokeColor }}>
              <Clock className="w-3 h-3" />
              <span>{t("serverLatency")}:</span>
              <span className="tabular-nums font-medium">{slot.server_latency_ms}ms</span>
            </p>
          )}
          {slot.message && slot.status !== "healthy" && (
            <p className="text-muted-foreground max-w-[200px] truncate opacity-80">
              {slot.message}
            </p>
          )}
        </div>
      );
    },
    [gatewayStrokeColor, serverStrokeColor, t, spanMs],
  );

  // ── Skeleton ───────────────────────────────────────────────────────────────
  if (slots.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className={cn("inline-flex w-2 h-2 rounded-full shrink-0", statusDotClass)} />
          <span className="font-medium text-sm truncate">{history.backendName}</span>
        </div>
        <div className="h-[180px] w-full bg-muted/20 rounded-xl animate-pulse flex items-center justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-2">
      {/* Title row */}
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-muted-foreground shrink-0" />
        <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wider truncate">
          {history.backendName}
        </p>
        <span className={cn("inline-flex w-2 h-2 rounded-full shrink-0", statusDotClass)} />
      </div>

      {/* Legend for agent mode */}
      {hasServerLatency && (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <div className="inline-flex items-center gap-1.5">
            <span
              className="inline-flex h-0.5 w-4 rounded-full"
              style={{ backgroundColor: gatewayStrokeColor }}
            />
            <span>{t("gatewayLatency")}</span>
          </div>
          <div className="inline-flex items-center gap-1.5">
            <span
              className="inline-flex h-0 w-4 border-t-2 border-dashed"
              style={{ borderColor: serverStrokeColor }}
            />
            <span>{t("serverLatency")}</span>
          </div>
        </div>
      )}

      {/* Stats row — mobile */}
      <div className="grid grid-cols-3 gap-2 lg:hidden">
        {stats.uptimePct !== null && (
          <div className="flex flex-col items-center py-1.5 px-1 rounded-md bg-secondary/50 border border-border/50">
            <span className="text-[9px] text-muted-foreground">{t("uptime")}</span>
            <span className={cn("text-xs font-bold tabular-nums",
              stats.uptimePct >= 99 ? "text-emerald-500" : stats.uptimePct >= 90 ? "text-amber-500" : "text-rose-500")}>
              {stats.uptimePct.toFixed(1)}%
            </span>
          </div>
        )}
        {stats.avgLatency !== null && (
          <div className="flex flex-col items-center py-1.5 px-1 rounded-md bg-secondary/50 border border-border/50">
            <span className="text-[9px] text-muted-foreground">{t("avgLatency")}</span>
            <span className={cn("text-xs font-semibold tabular-nums", TIER_TEXT[avgLatencyTier])}>
              {stats.avgLatency}ms
            </span>
          </div>
        )}
        {stats.maxLatency !== null && (
          <div className="flex flex-col items-center py-1.5 px-1 rounded-md bg-secondary/50 border border-border/50">
            <span className="text-[9px] text-muted-foreground">{t("maxLatency")}</span>
            <span className={cn("text-xs font-semibold tabular-nums", TIER_TEXT[maxLatencyTier])}>
              {stats.maxLatency}ms
            </span>
          </div>
        )}
      </div>

      {/* Stats row — desktop */}
      <div className="hidden lg:flex items-center gap-6 text-xs">
        {stats.uptimePct !== null && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{t("uptime")}:</span>
            <span className={cn("font-semibold tabular-nums",
              stats.uptimePct >= 99 ? "text-emerald-500" : stats.uptimePct >= 90 ? "text-amber-500" : "text-rose-500")}>
              {stats.uptimePct.toFixed(1)}%
            </span>
          </div>
        )}
        {stats.avgLatency !== null && (
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">{t("avgLatency")}:</span>
            <span className={cn("font-semibold tabular-nums", TIER_TEXT[avgLatencyTier])}>
              {stats.avgLatency}ms
            </span>
          </div>
        )}
        {stats.maxLatency !== null && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{t("maxLatency")}:</span>
            <span className={cn("font-semibold tabular-nums", TIER_TEXT[maxLatencyTier])}>
              {stats.maxLatency}ms
            </span>
          </div>
        )}
        {stats.gaps > 0 && (
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-slate-400 tabular-nums">
              {stats.gaps} {t("gaps")}
            </span>
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="relative h-[180px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={slots} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`colorHealth-${history.backendId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={strokeColor} stopOpacity={0.3} />
                <stop offset="95%" stopColor={strokeColor} stopOpacity={0} />
              </linearGradient>
            </defs>

            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="#888888"
              strokeOpacity={0.2}
            />

            {refSpans.filter((s) => s.type !== "gap").map((span, i) => (
              <ReferenceArea
                key={i}
                x1={span.x1}
                x2={span.x2}
                fill={
                  span.type === "unhealthy"
                    ? "rgba(244,63,94,0.22)"
                    : "rgba(251,191,36,0.18)"
                }
                stroke={
                  span.type === "unhealthy"
                    ? "rgba(244,63,94,0.5)"
                    : "rgba(251,191,36,0.4)"
                }
                strokeOpacity={1}
              />
            ))}

            <XAxis
              dataKey="time"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "#888888" }}
              interval="preserveStartEnd"
              minTickGap={40}
              tickFormatter={(v) => labelMap.get(v) ?? v}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: "#888888" }}
              tickFormatter={hasLatency ? (v) => `${v}ms` : () => ""}
              width={hasLatency ? 44 : 0}
              domain={hasLatency ? [0, latencyDomainMax ?? "auto"] : [0, 1.2]}
            />
            <Tooltip content={CustomTooltip} />

            {/* Primary curve: latency when available, otherwise online fallback */}
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={gatewayStrokeColor}
              strokeWidth={2}
              fillOpacity={1}
              fill={`url(#colorHealth-${history.backendId})`}
              connectNulls={false}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 3 }}
            />
            {/* Server latency curve - show only for agent mode */}
            {hasServerLatency && (
              <Area
                type="monotone"
                dataKey="server_latency_ms"
                stroke={serverStrokeColor}
                strokeWidth={2}
                strokeDasharray="5 4"
                fill="none"
                fillOpacity={0}
                connectNulls={false}
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: 3 }}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
