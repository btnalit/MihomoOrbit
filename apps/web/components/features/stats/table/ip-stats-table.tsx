"use client";

import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Rows3,
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
  Globe,
  ChevronDown,
  ChevronUp,
  Server,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CountryFlag } from "@/components/features/countries";
import { CopyIconButton } from "@/components/common/copy-icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatBytes, formatNumber } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { api, type TimeRange } from "@/lib/api";
import { useStableTimeRange } from "@/lib/hooks/use-stable-time-range";
import { keepPreviousByIdentity } from "@/lib/query-placeholder";
import {
  getIPDomainDetailsQueryKey,
  getIPProxyStatsQueryKey,
} from "@/lib/stats-query-keys";
import { IPExpandedDetails } from "./expanded-details";
import { ProxyChainBadge } from "@/components/features/proxies/proxy-chain-badge";
import { ExpandReveal } from "@/components/ui/expand-reveal";
import { InsightTableSkeleton } from "@/components/ui/insight-skeleton";
import { IPPreview } from "./ip-preview";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import {
  PAGE_SIZE_OPTIONS,
  getIPGradient,
  getPageNumbers,
  type PageSize,
  type IPSortKey,
  type SortOrder,
} from "@/lib/stats-utils";
import { useCountryName } from "@/lib/i18n-country";
import { normalizeGeoIP } from "@neko-master/shared";
import type { IPStats } from "@neko-master/shared";

const DETAIL_QUERY_STALE_MS = 30_000;
type IPTableMode = "local" | "remote";

interface IPStatsTableProps {
  ips: IPStats[];
  loading?: boolean;
  title?: string;
  showHeader?: boolean;
  pageSize?: PageSize;
  onPageSizeChange?: (size: PageSize) => void;
  activeBackendId?: number;
  timeRange?: TimeRange;
  sourceIP?: string;
  sourceChain?: string;
  richExpand?: boolean;
  showProxyColumn?: boolean;
  showProxyTrafficInExpand?: boolean;
  mode?: IPTableMode;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  sortKeyValue?: IPSortKey;
  sortOrderValue?: SortOrder;
  onSortChange?: (key: IPSortKey) => void;
  pageValue?: number;
  totalValue?: number;
  onPageChange?: (page: number) => void;
  ruleName?: string;
  contextKey?: string | number;
}

export function IPStatsTable({
  ips,
  loading = false,
  title,
  showHeader = true,
  pageSize: controlledPageSize,
  onPageSizeChange,
  activeBackendId,
  timeRange,
  sourceIP,
  sourceChain,
  richExpand = false,
  showProxyColumn = true,
  showProxyTrafficInExpand = true,
  mode = "local",
  searchValue,
  onSearchChange,
  sortKeyValue,
  sortOrderValue,
  onSortChange,
  pageValue,
  totalValue,
  onPageChange,
  ruleName,
  contextKey,
}: IPStatsTableProps) {
  const t = useTranslations("ips");
  const localizedName = useCountryName();
  const detailTimeRange = useStableTimeRange(timeRange);
  const isRemoteMode = mode === "remote";

  const [internalPage, setInternalPage] = useState(1);
  const [internalPageSize, setInternalPageSize] = useState<PageSize>(10);
  const pageSize = controlledPageSize ?? internalPageSize;
  const [internalSearch, setInternalSearch] = useState("");
  const [internalSortKey, setInternalSortKey] =
    useState<IPSortKey>("totalDownload");
  const [internalSortOrder, setInternalSortOrder] =
    useState<SortOrder>("desc");
  const [expandedIP, setExpandedIP] = useState<string | null>(null);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [mobileDetailIP, setMobileDetailIP] = useState<IPStats | null>(null);
  const page = isRemoteMode ? pageValue ?? 1 : internalPage;
  const search = isRemoteMode ? searchValue ?? "" : internalSearch;
  const sortKey = isRemoteMode ? sortKeyValue ?? "totalDownload" : internalSortKey;
  const sortOrder = isRemoteMode ? sortOrderValue ?? "desc" : internalSortOrder;
  const detailIPKey = mobileDetailsOpen ? (mobileDetailIP?.ip ?? null) : expandedIP;
  const mobileDetailIPGradient = getIPGradient(mobileDetailIP?.ip ?? "0.0.0.0");

  useEffect(() => {
    // Context switch (backend/device/proxy/rule binding change): collapse.
    setExpandedIP(null);
    setMobileDetailsOpen(false);
    setMobileDetailIP(null);
  }, [activeBackendId, sourceIP, sourceChain, richExpand, ruleName, contextKey]);

  useEffect(() => {
    if (!isRemoteMode) {
      setInternalPage(1);
      setInternalSearch("");
      setInternalSortKey("totalDownload");
      setInternalSortOrder("desc");
    }
  }, [contextKey, isRemoteMode]);

  useEffect(() => {
    if (!isRemoteMode) {
      setInternalPage(1);
    }
  }, [pageSize, isRemoteMode]);

  const setEffectivePageSize = (size: PageSize) => {
    if (onPageSizeChange) {
      onPageSizeChange(size);
    } else {
      setInternalPageSize(size);
    }

    if (isRemoteMode) {
      onPageChange?.(1);
    } else {
      setInternalPage(1);
    }
  };

  const setEffectivePage = (nextPage: number) => {
    if (isRemoteMode) {
      onPageChange?.(nextPage);
      return;
    }
    setInternalPage(nextPage);
  };

  const handleSearchInputChange = (value: string) => {
    if (isRemoteMode) {
      onSearchChange?.(value);
      onPageChange?.(1);
      return;
    }
    setInternalSearch(value);
    setInternalPage(1);
  };

  const expandedIPProxyQuery = useQuery({
    queryKey: getIPProxyStatsQueryKey(detailIPKey, activeBackendId, detailTimeRange, {
      sourceIP,
      sourceChain,
      rule: ruleName,
    }),
    queryFn: () =>
      ruleName
        ? api.getRuleIPProxyStats(
            ruleName,
            detailIPKey!,
            activeBackendId,
            detailTimeRange,
          )
        : api.getIPProxyStats(
            detailIPKey!,
            activeBackendId,
            detailTimeRange,
            sourceIP,
            sourceChain,
          ),
    enabled: richExpand && !!activeBackendId && !!detailIPKey,
    staleTime: DETAIL_QUERY_STALE_MS,
    placeholderData: (previousData, previousQuery) =>
      keepPreviousByIdentity(previousData, previousQuery, {
        ip: detailIPKey ?? "",
        backendId: activeBackendId ?? null,
        sourceIP: sourceIP ?? "",
        sourceChain: sourceChain ?? "",
        rule: ruleName ?? "",
      }),
  });

  const expandedIPDomainDetailsQuery = useQuery({
    queryKey: getIPDomainDetailsQueryKey(detailIPKey, activeBackendId, detailTimeRange, {
      sourceIP,
      sourceChain,
      rule: ruleName,
    }),
    queryFn: () =>
      ruleName
        ? api.getRuleIPDomainDetails(
            ruleName,
            detailIPKey!,
            activeBackendId,
            detailTimeRange,
          )
        : api.getIPDomainDetails(
            detailIPKey!,
            activeBackendId,
            detailTimeRange,
            sourceIP,
            undefined,
            sourceChain,
          ),
    enabled: richExpand && !!activeBackendId && !!detailIPKey,
    staleTime: DETAIL_QUERY_STALE_MS,
    placeholderData: (previousData, previousQuery) =>
      keepPreviousByIdentity(previousData, previousQuery, {
        ip: detailIPKey ?? "",
        backendId: activeBackendId ?? null,
        sourceIP: sourceIP ?? "",
        sourceChain: sourceChain ?? "",
        rule: ruleName ?? "",
      }),
  });

  const handleSort = (key: IPSortKey) => {
    if (isRemoteMode) {
      onSortChange?.(key);
      return;
    }

    if (internalSortKey === key) {
      setInternalSortOrder(internalSortOrder === "asc" ? "desc" : "asc");
    } else {
      setInternalSortKey(key);
      setInternalSortOrder("desc");
    }
    setInternalPage(1);
  };

  const toggleExpand = (ip: string) => {
    const newExpanded = expandedIP === ip ? null : ip;
    setExpandedIP(newExpanded);
  };

  const openMobileDetails = (ip: IPStats) => {
    setMobileDetailIP(ip);
    setMobileDetailsOpen(true);
  };

  const handleMobileDetailsOpenChange = (open: boolean) => {
    setMobileDetailsOpen(open);
    if (!open) {
      setMobileDetailIP(null);
    }
  };

  const SortIcon = ({ column }: { column: IPSortKey }) => {
    if (sortKey !== column) return <ArrowUpDown className="ml-1 h-3 w-3 text-muted-foreground" />;
    return sortOrder === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3 text-primary" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3 text-primary" />
    );
  };

  const filteredIPs = useMemo(() => {
    if (isRemoteMode) {
      return ips;
    }

    let result = [...ips];
    if (search) {
      const lower = search.toLowerCase();
      result = result.filter((ip) => ip.ip.toLowerCase().includes(lower));
    }
    result.sort((a, b) => {
      const aVal = a[sortKey] ?? "";
      const bVal = b[sortKey] ?? "";
      if (sortOrder === "asc") {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      }
      return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
    });
    return result;
  }, [ips, isRemoteMode, search, sortKey, sortOrder]);

  const visibleIPs = useMemo(() => {
    if (isRemoteMode) {
      return ips;
    }
    const start = (page - 1) * pageSize;
    return filteredIPs.slice(start, start + pageSize);
  }, [ips, filteredIPs, isRemoteMode, page, pageSize]);

  const totalItems = isRemoteMode ? totalValue ?? ips.length : filteredIPs.length;
  const totalPages =
    totalItems > 0 ? Math.max(1, Math.ceil(totalItems / pageSize)) : 0;
  const hasRows = visibleIPs.length > 0;
  const startIndex = totalItems === 0 ? 0 : Math.min((page - 1) * pageSize + 1, totalItems);
  const endIndex = Math.min(page * pageSize, totalItems);
  const ipColumnClass = showProxyColumn ? "col-span-3" : "col-span-4";
  const locationColumnClass = "col-span-2";
  const domainCountColumnClass = showProxyColumn ? "col-span-1" : "col-span-2";

  return (
    <Card>
      {showHeader && (
        <div className="p-4 border-b border-border/50">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">{title || t("associatedIPs")}</h3>
              <p className="text-sm text-muted-foreground">
                {totalItems} {t("ipsCount")}
              </p>
            </div>
            <div className="relative">
              <Input
                placeholder={t("search")}
                value={search}
                onChange={(e) => handleSearchInputChange(e.target.value)}
                className="h-9 w-full sm:w-[240px] bg-secondary/50 border-0"
              />
            </div>
          </div>
        </div>
      )}

      <CardContent className="p-0">
        {loading ? (
          <InsightTableSkeleton />
        ) : !hasRows ? (
          <div className="text-center py-12 text-muted-foreground">
            {search ? t("noResults") : t("noData")}
          </div>
        ) : (
          <>
            <div className="hidden sm:grid grid-cols-12 gap-3 px-5 py-3 bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <div
                className={cn(
                  ipColumnClass,
                  "flex items-center cursor-pointer hover:text-foreground transition-colors",
                )}
                onClick={() => handleSort("ip")}
              >
                {t("ip")}
                <SortIcon column="ip" />
              </div>
              {showProxyColumn && (
                <div className="col-span-2 flex items-center">{t("proxy")}</div>
              )}
              <div className={cn(locationColumnClass, "flex items-center")}>{t("location")}</div>
              <div
                className="col-span-2 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                onClick={() => handleSort("totalDownload")}
              >
                {t("download")}
                <SortIcon column="totalDownload" />
              </div>
              <div
                className="col-span-1 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                onClick={() => handleSort("totalUpload")}
              >
                {t("upload")}
                <SortIcon column="totalUpload" />
              </div>
              <div
                className="col-span-1 flex items-center justify-end cursor-pointer hover:text-foreground transition-colors"
                onClick={() => handleSort("totalConnections")}
              >
                {t("conn")}
                <SortIcon column="totalConnections" />
              </div>
              <div className={cn(domainCountColumnClass, "flex items-center justify-end")}>
                {t("domainCount")}
              </div>
            </div>

            <div className="sm:hidden flex items-center gap-2 px-4 py-2 bg-secondary/30 overflow-x-auto scrollbar-hide">
              {([
                { key: "ip" as IPSortKey, label: t("ip") },
                { key: "totalDownload" as IPSortKey, label: t("download") },
                { key: "totalUpload" as IPSortKey, label: t("upload") },
                { key: "totalConnections" as IPSortKey, label: t("conn") },
              ]).map(({ key, label }) => (
                <button
                  key={key}
                  className={cn(
                    "flex items-center gap-0.5 px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
                    sortKey === key
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => handleSort(key)}
                >
                  {label}
                  {sortKey === key &&
                    (sortOrder === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                </button>
              ))}
            </div>

            <div className="divide-y divide-border/30">
              {visibleIPs.map((ip) => {
                const isDesktopExpanded = expandedIP === ip.ip;
                const isMobileActive = mobileDetailsOpen && mobileDetailIP?.ip === ip.ip;
                const geo = normalizeGeoIP(ip.geoIP);
                const locationName = geo?.countryCode ? localizedName(geo.countryCode) : null;

                return (
                  <div key={ip.ip} className="group">
                    <div
                      className={cn(
                        "hidden sm:grid grid-cols-12 gap-3 px-5 py-4 items-center hover:bg-secondary/20 transition-colors cursor-pointer",
                        isDesktopExpanded && "bg-secondary/10",
                      )}
                      onClick={() => toggleExpand(ip.ip)}
                    >
                      <div className={cn(ipColumnClass, "flex items-center gap-3 min-w-0")}>
                        <div className={`w-5 h-5 rounded-md bg-gradient-to-br ${getIPGradient(ip.ip)} flex items-center justify-center shrink-0`}>
                          <Server className="w-3 h-3 text-white" />
                        </div>
                        <IPPreview
                          ip={ip.ip}
                          geoIP={ip.geoIP}
                          asn={ip.asn}
                          unknownLabel={t("unknownIP")}
                          unavailableLabel={t("unknown")}
                          copyLabel={t("copyIP")}
                          copiedLabel={t("copied")}
                          locationLabel={t("location")}
                          cityLabel={t("city")}
                          asnLabel={t("asn")}
                          asOrganizationLabel={t("asOrganization")}
                          className="flex-1"
                          triggerClassName="font-mono"
                        />
                      </div>

                      {showProxyColumn && (
                        <div className="col-span-2 flex items-center gap-1.5 min-w-0">
                          <ProxyChainBadge chains={ip.chains} />
                        </div>
                      )}

                      <div className={cn(locationColumnClass, "flex items-center gap-1.5 min-w-0")}>
                        {locationName ? (
                          <>
                            <CountryFlag country={geo?.countryCode || "UN"} className="h-3.5 w-5" title={locationName} />
                            <span className="text-xs whitespace-nowrap">{locationName}</span>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </div>

                      <div className="col-span-2 text-right tabular-nums text-sm whitespace-nowrap">
                        <span className="text-blue-500">{formatBytes(ip.totalDownload)}</span>
                      </div>

                      <div className="col-span-1 text-right tabular-nums text-sm whitespace-nowrap">
                        <span className="text-purple-500">{formatBytes(ip.totalUpload)}</span>
                      </div>

                      <div className="col-span-1 flex items-center justify-end">
                        <span className="px-2 py-0.5 rounded-full bg-secondary text-xs font-medium">
                          {formatNumber(ip.totalConnections)}
                        </span>
                      </div>

                      <div className={cn(domainCountColumnClass, "flex items-center justify-end")}>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "h-7 px-2 gap-1 text-xs font-medium transition-all",
                            isDesktopExpanded
                              ? "bg-primary/10 text-primary hover:bg-primary/20"
                              : "bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary",
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(ip.ip);
                          }}
                        >
                          <Globe className="h-3 w-3" />
                          {ip.domains?.length || 0}
                          {isDesktopExpanded ? (
                            <ChevronUp className="h-3 w-3 ml-0.5" />
                          ) : (
                            <ChevronDown className="h-3 w-3 ml-0.5" />
                          )}
                        </Button>
                      </div>
                    </div>

                    <div
                      className={cn(
                        "sm:hidden px-4 py-3 hover:bg-secondary/20 transition-colors cursor-pointer",
                        isMobileActive && "bg-secondary/10",
                      )}
                      onClick={() => openMobileDetails(ip)}
                    >
                      <div className="flex items-center gap-2.5 mb-2">
                        <div className={`w-5 h-5 rounded-md bg-gradient-to-br ${getIPGradient(ip.ip)} flex items-center justify-center shrink-0`}>
                          <Server className="w-2.5 h-2.5 text-white" />
                        </div>
                        <IPPreview
                          ip={ip.ip}
                          geoIP={ip.geoIP}
                          asn={ip.asn}
                          unknownLabel={t("unknownIP")}
                          unavailableLabel={t("unknown")}
                          copyLabel={t("copyIP")}
                          copiedLabel={t("copied")}
                          locationLabel={t("location")}
                          cityLabel={t("city")}
                          asnLabel={t("asn")}
                          asOrganizationLabel={t("asOrganization")}
                          className="flex-1"
                          triggerClassName="font-mono"
                          interactive={false}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "h-7 px-2 gap-1 text-xs font-medium shrink-0",
                            isMobileActive ? "bg-primary/10 text-primary" : "bg-secondary/50 text-muted-foreground",
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            openMobileDetails(ip);
                          }}
                        >
                          <Globe className="h-3 w-3" />
                          {ip.domains?.length || 0}
                          {isMobileActive ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        </Button>
                      </div>

                      <div className="flex items-center gap-2 mb-2 pl-[30px] flex-wrap">
                        {locationName && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <CountryFlag country={geo?.countryCode || "UN"} className="h-3.5 w-5" />
                            <span className="truncate">{locationName}</span>
                          </span>
                        )}
                        {showProxyColumn && ip.chains && ip.chains.length > 0 && (
                          <ProxyChainBadge
                            chains={ip.chains}
                            truncateLabel={false}
                            interactive={false}
                          />
                        )}
                      </div>

                      <div className="flex items-center justify-between text-xs pl-[30px]">
                        <span className="text-blue-500 tabular-nums whitespace-nowrap">↓ {formatBytes(ip.totalDownload)}</span>
                        <span className="text-purple-500 tabular-nums whitespace-nowrap">↑ {formatBytes(ip.totalUpload)}</span>
                        <span className="px-2 py-0.5 rounded-full bg-secondary text-muted-foreground font-medium">
                          {formatNumber(ip.totalConnections)} {t("conn")}
                        </span>
                      </div>
                    </div>

                    {isDesktopExpanded && (
                      <div className="hidden sm:block">
                        <ExpandReveal>
                          <IPExpandedDetails
                            ip={ip}
                            richExpand={richExpand}
                            proxyStats={expandedIPProxyQuery.data ?? []}
                            proxyStatsLoading={
                              expandedIPProxyQuery.isLoading &&
                              !expandedIPProxyQuery.data
                            }
                            domainDetails={expandedIPDomainDetailsQuery.data ?? []}
                            domainDetailsLoading={
                              expandedIPDomainDetailsQuery.isLoading &&
                              !expandedIPDomainDetailsQuery.data
                            }
                            associatedDomainsIcon="link"
                            labels={{
                              proxyTraffic: t("proxyTraffic"),
                              associatedDomains: t("associatedDomains"),
                              conn: t("conn"),
                            }}
                            showProxyTraffic={showProxyTrafficInExpand}
                          />
                        </ExpandReveal>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <Drawer open={mobileDetailsOpen} onOpenChange={handleMobileDetailsOpenChange}>
              <DrawerContent className="sm:hidden">
                <DrawerHeader className="border-b border-border/60 bg-background/95 px-5 pt-2 pb-2.5">
                  <div className="flex items-center gap-2.5 min-w-0 rounded-md border border-border/60 bg-muted/25 px-2.5 py-2">
                    <div className={`w-5 h-5 rounded-md bg-gradient-to-br ${mobileDetailIPGradient} flex items-center justify-center shrink-0`}>
                      <Server className="w-3 h-3 text-white" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <DrawerTitle className="text-left font-mono text-[15px] font-semibold leading-5 break-all">
                        {mobileDetailIP?.ip || t("unknownIP")}
                      </DrawerTitle>
                    </div>
                    <CopyIconButton
                      value={mobileDetailIP?.ip || ""}
                      copyLabel={t("copyIP")}
                      copiedLabel={t("copied")}
                      disabled={!mobileDetailIP?.ip}
                    />
                  </div>
                </DrawerHeader>
                <div className="max-h-[76vh] overflow-y-auto pb-[max(env(safe-area-inset-bottom),0px)]">
                  {mobileDetailIP ? (
                    <IPExpandedDetails
                      ip={mobileDetailIP}
                      richExpand={richExpand}
                      proxyStats={expandedIPProxyQuery.data ?? []}
                      proxyStatsLoading={
                        expandedIPProxyQuery.isLoading &&
                        !expandedIPProxyQuery.data
                      }
                      domainDetails={expandedIPDomainDetailsQuery.data ?? []}
                      domainDetailsLoading={
                        expandedIPDomainDetailsQuery.isLoading &&
                        !expandedIPDomainDetailsQuery.data
                      }
                      associatedDomainsIcon="link"
                      labels={{
                        proxyTraffic: t("proxyTraffic"),
                        associatedDomains: t("associatedDomains"),
                        conn: t("conn"),
                      }}
                      showProxyTraffic={showProxyTrafficInExpand}
                      showFullProxyChains
                      disableNestedInteractions
                      showIPLookupDetails
                    />
                  ) : null}
                </div>
              </DrawerContent>
            </Drawer>

            {totalItems > 0 && (
              <div className="p-3 border-t border-border/50 bg-secondary/20">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground hover:text-foreground">
                          <Rows3 className="h-4 w-4" />
                          <span>{pageSize} / {t("page")}</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        {PAGE_SIZE_OPTIONS.map((size) => (
                          <DropdownMenuItem
                            key={size}
                            onClick={() => setEffectivePageSize(size)}
                            className={pageSize === size ? "bg-primary/10" : ""}
                          >
                            {size} / {t("page")}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="flex flex-col sm:flex-row items-center gap-1 sm:gap-2">
                    <p className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                      {startIndex}-{endIndex} / {totalItems}
                    </p>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setEffectivePage(Math.max(1, page - 1))}
                        disabled={page <= 1}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      {getPageNumbers(page, totalPages).map((p, idx) =>
                        p === "..." ? (
                          <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground text-xs">
                            ...
                          </span>
                        ) : (
                          <Button
                            key={p}
                            variant={page === p ? "default" : "ghost"}
                            size="sm"
                            className="h-8 w-8 px-0 text-xs"
                            onClick={() => setEffectivePage(p as number)}
                          >
                            {p}
                          </Button>
                        ),
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setEffectivePage(Math.min(totalPages, page + 1))}
                        disabled={page >= totalPages}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
