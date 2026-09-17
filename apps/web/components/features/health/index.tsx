"use client";

import React, { useMemo } from "react";
import { useTranslations } from "next-intl";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Activity,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Server,
  Clock,
  BarChart2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, type TimeRange } from "@/lib/api";
import { useStableTimeRange } from "@/lib/hooks/use-stable-time-range";
import { BackendHealthChart } from "./backend-health-chart";

/** Derive bucket granularity from the time span (ms). */
function getBucketMinutes(spanMs: number): number {
  const hours = spanMs / 3_600_000;
  if (hours <= 2) return 1;
  if (hours <= 12) return 5;
  if (hours <= 48) return 15;
  return 60;
}

interface HealthContentProps {
  timeRange: TimeRange;
}

export function HealthContent({ timeRange }: HealthContentProps) {
  const t = useTranslations("health");

  // Round to minute so that per-second autoRefresh ticks don't change the query key
  const stableRange = useStableTimeRange(timeRange, { roundToMinute: true });

  const from = useMemo(
    () => new Date(stableRange?.start ?? timeRange.start),
    [stableRange?.start, timeRange.start],
  );
  const to = useMemo(
    () => new Date(stableRange?.end ?? timeRange.end),
    [stableRange?.end, timeRange.end],
  );
  const spanMs = to.getTime() - from.getTime();
  const bucketMinutes = getBucketMinutes(spanMs);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["backendHealthHistory", stableRange?.start, stableRange?.end],
    queryFn: () =>
      api.getBackendHealthHistory({
        from: from.toISOString().slice(0, 16),
        to:   to.toISOString().slice(0, 16),
      }),
    refetchInterval: 60_000,
    staleTime: 55_000,
    placeholderData: keepPreviousData,
  });

  const summary = useMemo(() => {
    if (!data?.length) return null;
    let latSum = 0, latCount = 0;
    let healthyBackends = 0, unhealthyBackends = 0;
    // Per-backend uptime over the selected range, averaged with EQUAL
    // weight per backend. The previous pooled-points ratio let a backend
    // with more health-log samples dominate the figure — "two devices, one
    // down" is a 50/50 statement about devices, not about sample counts.
    let uptimeSum = 0, uptimeBackends = 0;
    for (const backend of data) {
      const last = backend.points[backend.points.length - 1];
      if (last?.status === "healthy") healthyBackends++;
      else unhealthyBackends++;
      let healthy = 0;
      for (const p of backend.points) {
        if (p.status === "healthy") healthy++;
        const latency = p.latency_ms ?? p.server_latency_ms;
        if (latency !== null) { latSum += latency; latCount++; }
      }
      if (backend.points.length > 0) {
        uptimeSum += (healthy / backend.points.length) * 100;
        uptimeBackends++;
      }
    }
    return {
      // Headline "overall availability" is the CURRENT state — the share of
      // monitored backends whose latest check is healthy — so a recovered
      // backend counts again immediately. The range-wide figure below is
      // history (an SLA-style number) and is shown as the tile's caption,
      // not as the headline: the old code put history in the headline and
      // a device recovered an hour ago still read as "50.6% available".
      currentPct:       data.length > 0 ? (healthyBackends / data.length) * 100 : null,
      windowPct:        uptimeBackends > 0 ? uptimeSum / uptimeBackends : null,
      healthyBackends,
      unhealthyBackends,
      total:            data.length,
      avgLatency:       latCount > 0 ? Math.round(latSum / latCount) : null,
    };
  }, [data]);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5" />
            {t("title")}
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">{t("subtitle")}</p>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => refetch()}
          disabled={isFetching}>
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
        </Button>
      </div>

      {/* Summary stat cards — same grid density as Overview */}
      {summary && (
        <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          {/* Overall Uptime */}
          <div className="rounded-xl p-3.5 border bg-card shadow-xs flex flex-col">
            <div className="w-8 h-8 rounded-md flex items-center justify-center mb-2.5" style={{ backgroundColor: "#10b98115" }}>
              <Activity className="w-4 h-4" style={{ color: "#10b981" }} />
            </div>
            <p className="text-muted-foreground text-[11px] uppercase tracking-[0.14em] font-medium truncate">{t("overallUptime")}</p>
            <span className={cn("text-lg leading-none font-semibold mt-2.5 tabular-nums",
              (summary.currentPct ?? 0) >= 99 ? "text-emerald-500" : (summary.currentPct ?? 0) >= 90 ? "text-amber-500" : "text-rose-500")}>
              {summary.currentPct?.toFixed(0) ?? "—"}%
            </span>
            {summary.windowPct !== null && (
              <span className="text-[11px] text-muted-foreground mt-1 tabular-nums truncate">
                {t("windowUptime", { pct: summary.windowPct.toFixed(1) })}
              </span>
            )}
          </div>

          {/* Healthy Backends */}
          <div className="rounded-xl p-3.5 border bg-card shadow-xs flex flex-col">
            <div className="w-8 h-8 rounded-md flex items-center justify-center mb-2.5" style={{ backgroundColor: "#10b98115" }}>
              <CheckCircle2 className="w-4 h-4" style={{ color: "#10b981" }} />
            </div>
            <p className="text-muted-foreground text-[11px] uppercase tracking-[0.14em] font-medium truncate">{t("healthyBackends")}</p>
            <span className="text-lg leading-none font-semibold mt-2.5 tabular-nums text-emerald-500">
              {summary.healthyBackends}
            </span>
          </div>

          {/* Unhealthy Backends */}
          <div className="rounded-xl p-3.5 border bg-card shadow-xs flex flex-col">
            <div className="w-8 h-8 rounded-md flex items-center justify-center mb-2.5" style={{ backgroundColor: "#ef444415" }}>
              <XCircle className="w-4 h-4" style={{ color: "#ef4444" }} />
            </div>
            <p className="text-muted-foreground text-[11px] uppercase tracking-[0.14em] font-medium truncate">{t("unhealthyBackends")}</p>
            <span className={cn("text-lg leading-none font-semibold mt-2.5 tabular-nums",
              summary.unhealthyBackends > 0 ? "text-rose-500" : "text-foreground")}>
              {summary.unhealthyBackends}
            </span>
          </div>

          {/* Total Backends */}
          <div className="rounded-xl p-3.5 border bg-card shadow-xs flex flex-col">
            <div className="w-8 h-8 rounded-md flex items-center justify-center mb-2.5" style={{ backgroundColor: "#3b82f615" }}>
              <Server className="w-4 h-4" style={{ color: "#3b82f6" }} />
            </div>
            <p className="text-muted-foreground text-[11px] uppercase tracking-[0.14em] font-medium truncate">{t("backendsMonitored")}</p>
            <span className="text-lg leading-none font-semibold mt-2.5 tabular-nums">
              {summary.total}
            </span>
          </div>

          {/* Avg Latency */}
          <div className="rounded-xl p-3.5 border bg-card shadow-xs flex flex-col">
            <div className="w-8 h-8 rounded-md flex items-center justify-center mb-2.5" style={{ backgroundColor: "#8b5cf615" }}>
              <Clock className="w-4 h-4" style={{ color: "#8b5cf6" }} />
            </div>
            <p className="text-muted-foreground text-[11px] uppercase tracking-[0.14em] font-medium truncate">{t("overallAvgLatency")}</p>
            <span className="text-lg leading-none font-semibold mt-2.5 tabular-nums">
              {summary.avgLatency !== null ? `${summary.avgLatency}ms` : "—"}
            </span>
          </div>

          {/* Bucket Size */}
          <div className="rounded-xl p-3.5 border bg-card shadow-xs flex flex-col">
            <div className="w-8 h-8 rounded-md flex items-center justify-center mb-2.5" style={{ backgroundColor: "#f59e0b15" }}>
              <BarChart2 className="w-4 h-4" style={{ color: "#f59e0b" }} />
            </div>
            <p className="text-muted-foreground text-[11px] uppercase tracking-[0.14em] font-medium truncate">{t("granularity")}</p>
            <span className="text-lg leading-none font-semibold mt-2.5 tabular-nums">
              {bucketMinutes < 60
                ? t("minuteBucket", { n: bucketMinutes })
                : t("hourBucket", { n: bucketMinutes / 60 })}
            </span>
          </div>
        </div>
      )}

      {/* Per-backend charts */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <Card key={i}>
              <CardContent className="p-5 space-y-3">
                <div className="h-4 w-32 bg-muted/50 rounded animate-pulse" />
                <div className="h-14 w-full bg-muted/30 rounded animate-pulse" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !data?.length ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">
            <Activity className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">{t("noBackends")}</p>
            <p className="text-sm mt-1 opacity-70">{t("noBackendsHint")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {data.map((backend) => (
            <Card key={backend.backendId}>
              <CardContent className="px-4 pt-3 pb-2">
                <BackendHealthChart
                  history={backend}
                  from={from}
                  to={to}
                  bucketMinutes={bucketMinutes}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center pb-2">
        {t("checkInterval")}
      </p>
    </div>
  );
}
