"use client";

import { useMemo, useState } from "react";
import { Globe, Link2, ArrowUpDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { OverviewCard } from "@/components/common";
import { TopListItem } from "@/components/common";
import { Button } from "@/components/ui/button";
import { formatBytes, formatNumber } from "@/lib/utils";
import { useSettings, getFaviconUrl } from "@/lib/settings";
import type { DomainStats } from "@neko-master/shared";

interface DomainTopListProps {
  data: DomainStats[];
  limit?: number;
  onViewAll?: () => void;
}

type SortBy = "traffic" | "connections";

const COLORS = [
  "#3B82F6", "#8B5CF6", "#06B6D4", "#10B981", "#F59E0B", 
  "#EF4444", "#EC4899", "#6366F1"
];

function getInitials(domain: string): string {
  return domain.charAt(0).toUpperCase();
}

export function DomainTopList({ data, limit = 7, onViewAll }: DomainTopListProps) {
  const [sortBy, setSortBy] = useState<SortBy>("traffic");
  const t = useTranslations("topDomains");
  const proxiesT = useTranslations("proxies");
  const { settings } = useSettings();
  const faviconDisabled = settings.faviconProvider === "off";

  const { domains, totalTraffic, totalConnections } = useMemo(() => {
    if (!data) return { domains: [], totalTraffic: 0, totalConnections: 0 };
    
    const sorted = [...data]
      .sort((a, b) => {
      if (sortBy === "traffic") {
        const totalA = a.totalDownload + a.totalUpload;
        const totalB = b.totalDownload + b.totalUpload;
        return totalB - totalA;
      }
      return b.totalConnections - a.totalConnections;
    });

    const list = sorted.slice(0, limit).map((d, i) => ({
      ...d,
      total: d.totalDownload + d.totalUpload,
      color: COLORS[i % COLORS.length],
    }));
    
    const totalT = list.reduce((sum, d) => sum + d.total, 0);
    const totalC = list.reduce((sum, d) => sum + d.totalConnections, 0);
    
    return { domains: list, totalTraffic: totalT, totalConnections: totalC };
  }, [data, limit, sortBy]);

  const toggleSort = () => {
    setSortBy(prev => prev === "traffic" ? "connections" : "traffic");
  };

  // Get favicon URL using current provider
  const getFaviconForDomain = (domain: string) => {
    return getFaviconUrl(domain, settings.faviconProvider);
  };

  if (domains.length === 0) {
    return (
      <OverviewCard title={t("title")} icon={<Globe className="w-4 h-4" />}>
        <div className="py-8 text-center text-sm text-muted-foreground">
          {proxiesT("noData")}
        </div>
      </OverviewCard>
    );
  }

  return (
    <OverviewCard 
      title={t("title")} 
      icon={<Globe className="w-4 h-4" />}
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
        {domains.map((domain, index) => (
          <TopListItem
            key={domain.domain}
            rank={index + 1}
            icon={
              faviconDisabled ? (
                <span className="w-5 h-5 rounded bg-muted flex items-center justify-center">
                  <Globe className="w-3 h-3 text-muted-foreground" />
                </span>
              ) : (
                <img
                  src={getFaviconForDomain(domain.domain)}
                  alt=""
                  className="w-5 h-5"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.style.display = "none";
                    target.parentElement!.innerHTML = `<span class="text-xs font-bold text-muted-foreground">${getInitials(domain.domain)}</span>`;
                  }}
                />
              )
            }
            title={domain.domain}
            subtitle={sortBy === "traffic" 
              ? `${formatNumber(domain.totalConnections)} ${t("connections")}` 
              : `${formatBytes(domain.total)}`
            }
            value={sortBy === "traffic" ? domain.total : domain.totalConnections}
            total={sortBy === "traffic" ? totalTraffic : totalConnections}
            color={domain.color}
            valueFormatter={sortBy === "connections" ? (v) => `${v}` : undefined}
          />
        ))}
      </div>
    </OverviewCard>
  );
}
