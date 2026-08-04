"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { api, type TimeRange } from "@/lib/api";
import { useStableTimeRange } from "@/lib/hooks/use-stable-time-range";
import { useStatsWebSocket } from "@/lib/websocket";
import { getDomainsQueryKey } from "@/lib/stats-query-keys";
import {
  type DomainSortKey,
  type PageSize,
  type SortOrder,
} from "@/lib/stats-utils";
import { DomainStatsTable } from "./domain-stats-table";
import type { DomainStats, StatsSummary } from "@neko-master/shared";

interface DomainsTableProps {
  activeBackendId?: number;
  timeRange?: TimeRange;
  autoRefresh?: boolean;
  pageSize?: PageSize;
  onPageSizeChange?: (size: PageSize) => void;
}

const DOMAINS_WS_MIN_PUSH_MS = 3_000;

type DomainsPageQueryState = {
  offset: number;
  limit: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  search?: string;
};

type DomainsPageState = {
  data: DomainStats[];
  total: number;
  query: DomainsPageQueryState;
  backendId?: number;
};

export function DomainsTable({
  activeBackendId,
  timeRange,
  autoRefresh = true,
  pageSize: controlledPageSize,
  onPageSizeChange,
}: DomainsTableProps) {
  const t = useTranslations("domains");
  const stableTimeRange = useStableTimeRange(timeRange, { roundToMinute: true });

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortKey, setSortKey] = useState<DomainSortKey>("totalDownload");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [internalPageSize, setInternalPageSize] = useState<PageSize>(10);
  const [wsDomainsPage, setWsDomainsPage] = useState<DomainsPageState | null>(
    null,
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pageSize = controlledPageSize ?? internalPageSize;
  const pageOffset = (currentPage - 1) * pageSize;
  const wsPageSearch = debouncedSearch || undefined;

  const setEffectivePageSize = useCallback(
    (size: PageSize) => {
      if (onPageSizeChange) {
        onPageSizeChange(size);
      } else {
        setInternalPageSize(size);
      }
    },
    [onPageSizeChange],
  );

  const wsPageEnabled = autoRefresh && !!activeBackendId;
  const { status: wsPageStatus } = useStatsWebSocket({
    backendId: activeBackendId,
    range: stableTimeRange,
    minPushIntervalMs: DOMAINS_WS_MIN_PUSH_MS,
    includeSummary: false,
    includeDomainsPage: wsPageEnabled,
    domainsPageOffset: pageOffset,
    domainsPageLimit: pageSize,
    domainsPageSortBy: sortKey,
    domainsPageSortOrder: sortOrder,
    domainsPageSearch: wsPageSearch,
    trackLastMessage: false,
    enabled: wsPageEnabled,
    onMessage: useCallback(
      (stats: StatsSummary) => {
        const query = stats.domainsPageQuery;
        const page = stats.domainsPage;
        if (!page || !query) return;

        setWsDomainsPage({
          data: page.data,
          total: page.total,
          query: {
            offset: query.offset,
            limit: query.limit,
            sortBy: query.sortBy || "totalDownload",
            sortOrder: query.sortOrder === "asc" ? "asc" : "desc",
            search: query.search || undefined,
          },
          backendId: activeBackendId,
        });
      },
      [activeBackendId],
    ),
  });

  const wsDomainsPageMatchesCurrent =
    wsDomainsPage !== null &&
    wsDomainsPage.backendId === activeBackendId &&
    wsDomainsPage.query.offset === pageOffset &&
    wsDomainsPage.query.limit === pageSize &&
    (wsDomainsPage.query.sortBy || "totalDownload") === sortKey &&
    (wsDomainsPage.query.sortOrder || "desc") === sortOrder &&
    (wsDomainsPage.query.search || undefined) === wsPageSearch;

  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [search]);

  const domainsQuery = useQuery({
    queryKey: getDomainsQueryKey(
      activeBackendId,
      {
        offset: pageOffset,
        limit: pageSize,
        sortBy: sortKey,
        sortOrder,
        search: debouncedSearch || undefined,
      },
      stableTimeRange,
    ),
    queryFn: () =>
      api.getDomains(activeBackendId, {
        offset: pageOffset,
        limit: pageSize,
        sortBy: sortKey,
        sortOrder,
        search: debouncedSearch || undefined,
        start: stableTimeRange?.start,
        end: stableTimeRange?.end,
      }),
    enabled:
      !!activeBackendId &&
      (!wsPageEnabled || wsPageStatus !== "connected" || !wsDomainsPageMatchesCurrent),
    placeholderData: keepPreviousData,
  });

  const hasWsDomainsPage =
    wsPageEnabled && wsPageStatus === "connected" && wsDomainsPageMatchesCurrent;
  const data = hasWsDomainsPage ? wsDomainsPage.data : domainsQuery.data?.data ?? [];
  const total = hasWsDomainsPage ? wsDomainsPage.total : domainsQuery.data?.total ?? 0;
  const loading = !hasWsDomainsPage && domainsQuery.isLoading && !domainsQuery.data;

  const handleSortChange = useCallback(
    (key: DomainSortKey) => {
      if (sortKey === key) {
        setSortOrder(sortOrder === "asc" ? "desc" : "asc");
      } else {
        setSortKey(key);
        setSortOrder("desc");
      }
      setCurrentPage(1);
    },
    [sortKey, sortOrder],
  );

  return (
    <DomainStatsTable
      domains={data}
      loading={loading}
      title={t("title")}
      showHeader
      showLastSeenColumn
      pageSize={pageSize}
      onPageSizeChange={setEffectivePageSize}
      activeBackendId={activeBackendId}
      timeRange={timeRange}
      richExpand
      mode="remote"
      searchValue={search}
      onSearchChange={setSearch}
      sortKeyValue={sortKey}
      sortOrderValue={sortOrder}
      onSortChange={handleSortChange}
      pageValue={currentPage}
      totalValue={total}
      onPageChange={setCurrentPage}
    />
  );
}
