"use client";

import { useMemo, useState } from "react";
import { Server, Link2, ArrowUpDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { CountryFlag, extractCountryCodeFromText, stripLeadingFlagEmoji } from "@/components/features/countries";
import { OverviewCard } from "@/components/common";
import { TopListItem } from "@/components/common";
import { Button } from "@/components/ui/button";
import { formatBytes, formatNumber, cn } from "@/lib/utils";
import { useIsWindows } from "@/lib/hooks/use-is-windows";
import type { ProxyStats } from "@neko-master/shared";

interface ProxyTopListProps {
  data: ProxyStats[];
  limit?: number;
  onViewAll?: () => void;
}

type SortBy = "traffic" | "connections";

const COLORS = ["#3B82F6", "#8B5CF6", "#06B6D4", "#10B981", "#F59E0B"];

function normalizeProxyName(name: string): string {
  const normalized = name
    .replace(/^\["?/, "")
    .replace(/"?\]$/, "")
    .trim();
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

export function ProxyTopList({ data, limit = 5, onViewAll }: ProxyTopListProps) {
  const [sortBy, setSortBy] = useState<SortBy>("traffic");
  const t = useTranslations("topProxies");
  const proxiesT = useTranslations("proxies");
  const isWindows = useIsWindows();

  const { proxies, totalTraffic, totalConnections } = useMemo(() => {
    if (!data) return { proxies: [], totalTraffic: 0, totalConnections: 0 };
    
    const sorted = [...data].sort((a, b) => {
      if (sortBy === "traffic") {
        const totalA = a.totalDownload + a.totalUpload;
        const totalB = b.totalDownload + b.totalUpload;
        return totalB - totalA;
      }
      return b.totalConnections - a.totalConnections;
    });

    const list = sorted.slice(0, limit).map((p, i) => ({
      ...p,
      total: p.totalDownload + p.totalUpload,
      color: COLORS[i % COLORS.length],
      displayName: formatProxyName(p.chain),
      countryCode: getProxyCountryCode(p.chain),
    }));
    
    const totalT = list.reduce((sum, p) => sum + p.total, 0);
    const totalC = list.reduce((sum, p) => sum + p.totalConnections, 0);
    
    return { proxies: list, totalTraffic: totalT, totalConnections: totalC };
  }, [data, limit, sortBy]);

  const toggleSort = () => {
    setSortBy(prev => prev === "traffic" ? "connections" : "traffic");
  };

  if (proxies.length === 0) {
    return (
      <OverviewCard title={t("title")} icon={<Server className="w-4 h-4" />}>
        <div className="py-8 text-center text-sm text-muted-foreground">
          {proxiesT("noData")}
        </div>
      </OverviewCard>
    );
  }

  return (
    <OverviewCard 
      title={t("title")} 
      icon={<Server className="w-4 h-4" />}
      action={
        <Button 
          variant="ghost" 
          size="sm" 
          className="h-7 px-2 text-xs"
          onClick={toggleSort}
        >
          {sortBy === "traffic" ? (
            <><ArrowUpDown className="w-3 h-3 mr-1" /> {t("sortByTraffic")}</>
          ) : (
            <><Link2 className="w-3 h-3 mr-1" /> {t("sortByConnections")}</>
          )}
        </Button>
      }
      footer={
        onViewAll && (
          <Button variant="ghost" size="sm" className="w-full h-9 text-xs" onClick={onViewAll}>
            {t("viewAll")}
          </Button>
        )
      }
    >
      <div className="space-y-1 min-h-[320px]">
        {proxies.map((proxy, index) => (
          <TopListItem
            key={proxy.chain}
            rank={index + 1}
            icon={<CountryFlag country={proxy.countryCode} className="h-4 w-6" />}
            title={proxy.displayName}
            titleClassName={cn(isWindows && "emoji-flag-font")}
            subtitle={sortBy === "traffic" 
              ? `${formatNumber(proxy.totalConnections)} ${proxiesT("connections")}` 
              : `${formatBytes(proxy.total)}`
            }
            value={sortBy === "traffic" ? proxy.total : proxy.totalConnections}
            total={sortBy === "traffic" ? totalTraffic : totalConnections}
            color={proxy.color}
            valueFormatter={sortBy === "connections" ? (v) => `${v}` : undefined}
          />
        ))}
      </div>
    </OverviewCard>
  );
}
