"use client";

import React, { useMemo } from "react";
import { Globe, ArrowRight, BarChart3, Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { CountryFlag } from "@/components/features/countries";
import { formatBytes, formatNumber, cn } from "@/lib/utils";
import { useResponsiveItemCount } from "@/lib/hooks/use-responsive-item-count";
import { useCountryName } from "@/lib/i18n-country";
import type { CountryStats } from "@neko-master/shared";

interface TopCountriesSimpleProps {
  countries: CountryStats[];
  sortBy: "traffic" | "connections";
  onSortChange: (mode: "traffic" | "connections") => void;
  onViewAll?: () => void;
  isLoading?: boolean;
}

export const TopCountriesSimple = React.memo(function TopCountriesSimple({
  countries,
  sortBy,
  onSortChange,
  onViewAll,
  isLoading,
}: TopCountriesSimpleProps) {
  const t = useTranslations("topCountries");
  const countryName = useCountryName();
  const itemCount = useResponsiveItemCount();

  const sortedCountries = useMemo(() => {
    if (!countries?.length) return [];
    return [...countries]
      .sort((a, b) => {
        if (sortBy === "traffic") {
          return (b.totalDownload + b.totalUpload) - (a.totalDownload + a.totalUpload);
        }
        return b.totalConnections - a.totalConnections;
      })
      .slice(0, itemCount);
  }, [countries, sortBy, itemCount]);

  const hasData = sortedCountries.length > 0;

  const maxTotal = useMemo(() => {
    if (!sortedCountries.length) return 1;
    return Math.max(...sortedCountries.map(c => c.totalDownload + c.totalUpload));
  }, [sortedCountries]);

  const totalTraffic = useMemo(() => {
    if (!countries?.length) return 1;
    return countries.reduce((sum, c) => sum + c.totalDownload + c.totalUpload, 0);
  }, [countries]);

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
        {hasData ? sortedCountries.map((country, index) => {
          const total = country.totalDownload + country.totalUpload;
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
              key={country.country}
              className="p-2.5 rounded-xl border border-border/50 bg-card/50 hover:bg-card transition-colors"
            >
              {/* Row 1: Rank + Flag + Name + Total */}
              <div className="flex items-center gap-2 mb-1.5">
                <span className={cn(
                  "w-5 h-5 rounded-md text-[10px] font-bold flex items-center justify-center shrink-0",
                  badgeColor
                )}>
                  {index + 1}
                </span>
                <CountryFlag country={country.country} className="h-3.5 w-5" />
                <span className="flex-1 text-sm font-medium truncate" title={countryName(country.country)}>
                  {countryName(country.country)}
                </span>
                <span className="text-sm font-bold tabular-nums shrink-0">
                  {formatBytes(total)}
                </span>
              </div>

              {/* Row 2: Progress bar with download/upload breakdown */}
              <div className="pl-7 space-y-1.5">
                {/* Progress bar */}
                <div className="h-1.5 rounded-full bg-muted overflow-hidden flex">
                  <div 
                    className="h-full bg-blue-500 dark:bg-blue-400" 
                    style={{ width: `${(country.totalDownload / total) * barPercent}%` }}
                  />
                  <div 
                    className="h-full bg-purple-500 dark:bg-purple-400" 
                    style={{ width: `${(country.totalUpload / total) * barPercent}%` }}
                  />
                </div>
                {/* Stats */}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className="text-blue-500 dark:text-blue-400">↓ {formatBytes(country.totalDownload)}</span>
                    <span className="text-purple-500 dark:text-purple-400">↑ {formatBytes(country.totalUpload)}</span>
                    <span className="flex items-center gap-1 tabular-nums">
                      <Link2 className="w-3 h-3" />
                      {formatNumber(country.totalConnections)}
                    </span>
                  </div>
                  <span className="tabular-nums">{sharePercent.toFixed(1)}%</span>
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
              {/* Row 1: Rank + Flag + Name + Total - mb-1.5 like real data */}
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-5 h-5 rounded-md bg-muted/60 animate-pulse shrink-0" />
                <div className="w-5 h-[14px] rounded bg-muted/60 animate-pulse shrink-0" />
                <div className="flex-1 h-4 bg-muted/60 rounded animate-pulse" />
                <div className="w-12 h-4 bg-muted/60 rounded animate-pulse shrink-0" />
              </div>
              {/* Row 2: Progress bar + Stats placeholder - space-y-1.5 like real data */}
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
    JSON.stringify(prev.countries) === JSON.stringify(next.countries) &&
    prev.sortBy === next.sortBy
  );
});
