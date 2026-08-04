"use client";

import { useMemo, useState } from "react";
import { Server, Link2, ArrowUpDown, ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  CountryFlag,
  extractCountryCodeFromText,
  stripLeadingFlagEmoji,
} from "@/components/features/countries";
import { formatBytes, formatNumber, cn } from "@/lib/utils";
import { useIsWindows } from "@/lib/hooks/use-is-windows";
import type { ProxyStats } from "@neko-master/shared";

interface ProxyTopGridProps {
  data: ProxyStats[];
  limit?: number;
  onViewAll?: () => void;
}

type SortBy = "traffic" | "connections";

const COLORS = [
  "#3B82F6",
  "#8B5CF6",
  "#06B6D4",
  "#10B981",
  "#F59E0B",
  "#EF4444",
];

function normalizeProxyName(name: string): string {
  const normalized = name.replace(/^\["?/, "").replace(/"?\]$/, "").trim();
  const parts = normalized
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[0] || normalized;
}

function formatProxyName(name: string): string {
  if (!name) return "DIRECT";
  return stripLeadingFlagEmoji(normalizeProxyName(name));
}

function getProxyCountryCode(name: string): string {
  const cleaned = normalizeProxyName(name);
  if (cleaned === "DIRECT" || cleaned === "Direct") {
    return "DIRECT";
  }
  return extractCountryCodeFromText(cleaned) ?? "UNKNOWN";
}

export function ProxyTopGrid({
  data,
  limit = 5,
  onViewAll,
}: ProxyTopGridProps) {
  const [sortBy, setSortBy] = useState<SortBy>("traffic");
  const t = useTranslations("topProxies");
  const proxiesT = useTranslations("proxies");
  const isWindows = useIsWindows();

  const proxies = useMemo(() => {
    if (!data) return [];

    const sorted = [...data].sort((a, b) => {
      if (sortBy === "traffic") {
        return (
          b.totalDownload + b.totalUpload - (a.totalDownload + a.totalUpload)
        );
      }
      return b.totalConnections - a.totalConnections;
    });

    return sorted.slice(0, limit).map((p, i) => ({
      ...p,
      total: p.totalDownload + p.totalUpload,
      color: COLORS[i % COLORS.length],
      displayName: formatProxyName(p.chain),
      countryCode: getProxyCountryCode(p.chain),
    }));
  }, [data, limit, sortBy]);

  const toggleSort = () =>
    setSortBy((prev) => (prev === "traffic" ? "connections" : "traffic"));

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Server className="w-4 h-4" />
            {t("title")}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={toggleSort}>
            {sortBy === "traffic" ? (
              <>
                <ArrowUpDown className="w-3 h-3 mr-1" />{" "}
                {proxiesT("sortByTraffic")}
              </>
            ) : (
              <>
                <Link2 className="w-3 h-3 mr-1" />{" "}
                {proxiesT("sortByConnections")}
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col pt-0">
        <div className="space-y-2 flex-1">
          {proxies.map((proxy, index) => (
            <div
              key={proxy.chain}
              className="flex items-center gap-3 p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-card transition-colors">
              {/* Rank */}
              <span
                className={`
                w-6 h-6 rounded-md text-xs font-bold flex items-center justify-center shrink-0
                ${
                  index < 3
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                }
              `}>
                {index + 1}
              </span>

              {/* Country */}
              <CountryFlag country={proxy.countryCode} className="h-4 w-6" />

              {/* Name */}
              <div className="flex-1 min-w-0">
                <p className={cn("font-medium text-sm truncate", isWindows && "emoji-flag-font")} title={proxy.chain}>
                  {proxy.displayName}
                </p>
              </div>

              {/* Stats */}
              <div className="flex items-center gap-4 text-xs">
                <span className="text-blue-500 tabular-nums">
                  ↓ {formatBytes(proxy.totalDownload)}
                </span>
                <span className="text-purple-500 tabular-nums">
                  ↑ {formatBytes(proxy.totalUpload)}
                </span>
                <span className="text-muted-foreground flex items-center gap-1">
                  <Link2 className="w-3 h-3" />
                  {formatNumber(proxy.totalConnections)}
                </span>
              </div>

              {/* Total */}
              <div className="text-right min-w-[80px]">
                <p className="font-bold tabular-nums">
                  {formatBytes(proxy.total)}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        {onViewAll && (
          <div className="mt-4 pt-3 border-t border-border/30">
            <Button
              variant="ghost"
              size="sm"
              className="w-full h-9 text-xs"
              onClick={onViewAll}>
              {proxiesT("viewAll")}
              <ArrowRight className="w-3 h-3 ml-1" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
