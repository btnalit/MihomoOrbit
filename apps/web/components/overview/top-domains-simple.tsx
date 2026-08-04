"use client";

import React, { useMemo } from "react";
import { Globe, ArrowRight, BarChart3, Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn, formatBytes, formatNumber } from "@/lib/utils";
import { useSettings, getFaviconUrl } from "@/lib/settings";
import { useResponsiveItemCount } from "@/lib/hooks/use-responsive-item-count";
import type { DomainStats } from "@neko-master/shared";

interface TopDomainsSimpleProps {
  domains: DomainStats[];
  sortBy: "traffic" | "connections";
  onSortChange: (mode: "traffic" | "connections") => void;
  onViewAll?: () => void;
  isLoading?: boolean;
}

function getInitials(domain: string): string {
  return domain.slice(0, 2).toUpperCase();
}

export const TopDomainsSimple = React.memo(function TopDomainsSimple({
  domains,
  sortBy,
  onSortChange,
  onViewAll,
  isLoading,
}: TopDomainsSimpleProps) {
  const t = useTranslations("topDomains");
  const { settings } = useSettings();
  const faviconDisabled = settings.faviconProvider === "off";
  const itemCount = useResponsiveItemCount();
  const sortedDomains = useMemo(() => {
    if (!domains?.length) return [];
    
    const sorted = [...domains]
      .sort((a, b) => {
      if (sortBy === "traffic") {
        const totalA = a.totalDownload + a.totalUpload;
        const totalB = b.totalDownload + b.totalUpload;
        return totalB - totalA;
      } else {
        return b.totalConnections - a.totalConnections;
      }
    });
    
    return sorted.slice(0, itemCount);
  }, [domains, sortBy, itemCount]);
  const hasData = sortedDomains.length > 0;

  const maxTotal = useMemo(() => {
    if (!sortedDomains.length) return 1;
    return Math.max(...sortedDomains.map(d => d.totalDownload + d.totalUpload));
  }, [sortedDomains]);

  const totalTraffic = useMemo(() => {
    if (!domains?.length) return 1;
    return domains.reduce((sum, d) => sum + d.totalDownload + d.totalUpload, 0);
  }, [domains]);
  // Get favicon URL using current provider
  const getFaviconForDomain = (domain: string) => {
    return getFaviconUrl(domain, settings.faviconProvider);
  };

  return (
    <div className="space-y-3 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <Globe className="w-4 h-4" />
          {t("title")}
        </h3>
        
        {/* Sort toggle */}
        <div className="flex items-center gap-0.5 bg-muted/50 rounded-lg p-0.5">
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 rounded-md transition-all",
              sortBy === "traffic" 
                ? "bg-background shadow-sm text-primary" 
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => onSortChange("traffic")}
            title={t("sortByTraffic")}
          >
            <BarChart3 className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 rounded-md transition-all",
              sortBy === "connections" 
                ? "bg-background shadow-sm text-primary" 
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => onSortChange("connections")}
            title={t("sortByConnections")}
          >
            <Link2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* List */}
      <div className="space-y-2 flex-1">
        {hasData ? sortedDomains.map((domain, index) => {
          const total = domain.totalDownload + domain.totalUpload;
          const barPercent = (total / maxTotal) * 100;
          const sharePercent = (total / totalTraffic) * 100;
          const badgeColor = index === 0
            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
            : index === 1
            ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
            : index === 2
            ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
            : "bg-muted text-muted-foreground";
          return (
            <div
              key={domain.domain}
              className="p-2.5 rounded-xl border border-border/50 bg-card/50 hover:bg-card transition-colors"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className={cn(
                  "w-5 h-5 rounded-md text-[10px] font-bold flex items-center justify-center shrink-0",
                  badgeColor
                )}>
                  {index + 1}
                </span>
                
                {/* Favicon */}
                <div className="w-5 h-5 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden">
                  {faviconDisabled ? (
                    <Globe className="w-3 h-3 text-muted-foreground" />
                  ) : (
                    <img
                      src={getFaviconForDomain(domain.domain)}
                      alt=""
                      className="w-4 h-4"
                      loading="lazy"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.style.display = "none";
                        const parent = target.parentElement;
                        if (parent) {
                          parent.innerHTML = `<span class="text-[9px] font-bold text-muted-foreground">${getInitials(domain.domain)}</span>`;
                        }
                      }}
                    />
                  )}
                </div>
                
                <span className="flex-1 text-sm font-medium truncate" title={domain.domain}>
                  {domain.domain}
                </span>
                
                <span className="text-sm font-bold tabular-nums shrink-0">
                  {formatBytes(total)}
                </span>
              </div>

              {/* Row 2: Progress bar + Stats */}
              <div className="pl-7 space-y-1.5">
                {/* Progress bar */}
                <div className="h-1.5 rounded-full bg-muted overflow-hidden flex">
                  <div
                    className="h-full bg-blue-500 dark:bg-blue-400"
                    style={{ width: `${(domain.totalDownload / total) * barPercent}%` }}
                  />
                  <div
                    className="h-full bg-purple-500 dark:bg-purple-400"
                    style={{ width: `${(domain.totalUpload / total) * barPercent}%` }}
                  />
                </div>
                {/* Stats */}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                  <span className="text-blue-500 dark:text-blue-400">↓ {formatBytes(domain.totalDownload)}</span>
                  <span className="text-purple-500 dark:text-purple-400">↑ {formatBytes(domain.totalUpload)}</span>
                    <span className="flex items-center gap-1 tabular-nums">
                      <Link2 className="w-3 h-3" />
                      {formatNumber(domain.totalConnections)}
                    </span>
                  </div>
                  <span className="tabular-nums">
                    {sharePercent.toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          );
        }) : isLoading ? (
          // Skeleton loading state - dynamic items with 2 rows each to match actual content height
          Array.from({ length: itemCount }).map((_, i) => (
            <div
              key={i}
              className="p-2.5 rounded-xl border border-border/50 bg-card/50"
            >
              {/* Row 1: Rank + Icon + Name + Total */}
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-5 h-5 rounded-md bg-muted/60 animate-pulse shrink-0" />
                <div className="w-5 h-5 rounded bg-muted/60 animate-pulse shrink-0" />
                <div className="flex-1 h-4 bg-muted/60 rounded animate-pulse" />
                <div className="w-12 h-4 bg-muted/60 rounded animate-pulse shrink-0" />
              </div>
              {/* Row 2: Progress bar + Stats placeholder */}
              <div className="pl-7 space-y-1.5">
                <div className="h-1.5 rounded-full bg-muted/60 animate-pulse" />
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-14 h-3 bg-muted/60 rounded animate-pulse" />
                    <div className="w-14 h-3 bg-muted/60 rounded animate-pulse" />
                    <div className="w-10 h-3 bg-muted/60 rounded animate-pulse" />
                  </div>
                  <div className="w-8 h-3 bg-muted/60 rounded animate-pulse" />
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="h-full min-h-[220px] rounded-xl border border-dashed border-border/60 bg-card/30 px-4 py-5">
            <div className="space-y-2">
              {[0, 1, 2].map((item) => (
                <div key={item} className="h-8 rounded-lg bg-muted/60 animate-pulse" />
              ))}
            </div>
            <div className="mt-4 text-center">
              <p className="text-sm font-medium text-muted-foreground">{t("noData")}</p>
              <p className="text-xs text-muted-foreground/80 mt-1">{t("noDataHint")}</p>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="pt-2 border-t border-border/30">
        <Button
          variant="ghost"
          size="sm"
          className="w-full h-9 text-xs"
          onClick={onViewAll}
          disabled={!hasData}>
          {t("viewAll")}
          <ArrowRight className="w-3 h-3 ml-1" />
        </Button>
      </div>
    </div>
  );
}, (prev, next) => {
  return (
    JSON.stringify(prev.domains) === JSON.stringify(next.domains) &&
    prev.sortBy === next.sortBy
  );
});
