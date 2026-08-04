"use client";

import { useMemo, useState } from "react";
import { Globe, Link2, ArrowUpDown, ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatBytes, formatNumber } from "@/lib/utils";
import { useSettings, getFaviconUrl } from "@/lib/settings";
import type { DomainStats } from "@neko-master/shared";

interface DomainTopGridProps {
  data: DomainStats[];
  limit?: number;
  onViewAll?: () => void;
}

type SortBy = "traffic" | "connections";

function getInitials(domain: string): string {
  return domain.slice(0, 2).toUpperCase();
}

export function DomainTopGrid({ data, limit = 5, onViewAll }: DomainTopGridProps) {
  const [sortBy, setSortBy] = useState<SortBy>("traffic");
  const t = useTranslations("topDomains");
  const proxiesT = useTranslations("proxies");
  const { settings } = useSettings();
  const faviconDisabled = settings.faviconProvider === "off";

  const domains = useMemo(() => {
    if (!data) return [];
    const sorted = [...data]
      .sort((a, b) => {
      if (sortBy === "traffic") {
        return (b.totalDownload + b.totalUpload) - (a.totalDownload + a.totalUpload);
      }
      return b.totalConnections - a.totalConnections;
    });
    return sorted.slice(0, limit).map(d => ({
      ...d,
      total: d.totalDownload + d.totalUpload,
    }));
  }, [data, limit, sortBy]);

  const toggleSort = () => setSortBy(prev => prev === "traffic" ? "connections" : "traffic");

  // Get favicon URL using current provider
  const getFaviconForDomain = (domain: string) => {
    return getFaviconUrl(domain, settings.faviconProvider);
  };

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Globe className="w-4 h-4" />
            {t("title")}
          </CardTitle>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={toggleSort}>
            {sortBy === "traffic" ? (
              <><ArrowUpDown className="w-3 h-3 mr-1" /> {proxiesT("sortByTraffic")}</>
            ) : (
              <><Link2 className="w-3 h-3 mr-1" /> {proxiesT("sortByConnections")}</>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col pt-0">
        <div className="space-y-2 flex-1">
          {domains.map((domain, index) => (
            <div
              key={domain.domain}
              className="p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-card transition-colors"
            >
              {/* Row 1: Rank + Icon + Domain + Total */}
              <div className="flex items-center gap-2 mb-2">
                <span className={`
                  w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center shrink-0
                  ${index < 3 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}
                `}>
                  {index + 1}
                </span>
                
                {faviconDisabled ? (
                  <span className="w-5 h-5 rounded bg-muted flex items-center justify-center">
                    <Globe className="w-3 h-3 text-muted-foreground" />
                  </span>
                ) : (
                  <img
                    src={getFaviconForDomain(domain.domain)}
                    alt=""
                    className="w-5 h-5 rounded"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.style.display = "none";
                      const parent = target.parentElement;
                      if (parent) {
                        parent.innerHTML = `<span class="w-5 h-5 rounded bg-muted flex items-center justify-center text-[9px] font-bold text-muted-foreground">${getInitials(domain.domain)}</span>`;
                      }
                    }}
                  />
                )}
                
                <span className="flex-1 text-sm font-medium truncate" title={domain.domain}>
                  {domain.domain}
                </span>
                
                <span className="text-sm font-bold tabular-nums text-foreground">
                  {formatBytes(domain.total)}
                </span>
              </div>

              {/* Row 2: Stats */}
              <div className="flex items-center justify-between text-xs text-muted-foreground pl-7">
                <div className="flex items-center gap-3">
                  <span className="text-blue-500">↓ {formatBytes(domain.totalDownload)}</span>
                  <span className="text-purple-500">↑ {formatBytes(domain.totalUpload)}</span>
                </div>
                <span className="flex items-center gap-1">
                  <Link2 className="w-3 h-3" />
                  {formatNumber(domain.totalConnections)}
                </span>
              </div>
            </div>
          ))}
        </div>

        {onViewAll && (
          <div className="mt-4 pt-3 border-t border-border/30">
            <Button variant="ghost" size="sm" className="w-full h-9 text-xs" onClick={onViewAll}>
              {proxiesT("viewAll")}
              <ArrowRight className="w-3 h-3 ml-1" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
