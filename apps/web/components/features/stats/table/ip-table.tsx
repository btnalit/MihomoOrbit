"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { api, type TimeRange } from "@/lib/api";
import { useStableTimeRange } from "@/lib/hooks/use-stable-time-range";
import { useStatsWebSocket } from "@/lib/websocket";
import { getIPsQueryKey } from "@/lib/stats-query-keys";
import {
  type IPSortKey,
  type PageSize,
  type SortOrder,
} from "@/lib/stats-utils";
import { IPStatsTable } from "./ip-stats-table";
import type { IPStats, StatsSummary } from "@neko-master/shared";

interface IPsTableProps {
  activeBackendId?: number;
  timeRange?: TimeRange;
  autoRefresh?: boolean;
  pageSize?: PageSize;
  onPageSizeChange?: (size: PageSize) => void;
}

const IPS_WS_MIN_PUSH_MS = 3_000;

type IPsPageQueryState = {
  offset: number;
  limit: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  search?: string;
};

type IPsPageState = {
  data: IPStats[];
  total: number;
  query: IPsPageQueryState;
  backendId?: number;
};

export function IPsTable({
  activeBackendId,
  timeRange,
  autoRefresh = true,
  pageSize: controlledPageSize,
  onPageSizeChange,
}: IPsTableProps) {
  const t = useTranslations("ips");
  const stableTimeRange = useStableTimeRange(timeRange, { roundToMinute: true });

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortKey, setSortKey] = useState<IPSortKey>("totalDownload");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [internalPageSize, setInternalPageSize] = useState<PageSize>(10);
  const [wsIPsPage, setWsIPsPage] = useState<IPsPageState | null>(null);
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
    minPushIntervalMs: IPS_WS_MIN_PUSH_MS,
    includeSummary: false,
    includeIPsPage: wsPageEnabled,
    ipsPageOffset: pageOffset,
    ipsPageLimit: pageSize,
    ipsPageSortBy: sortKey,
    ipsPageSortOrder: sortOrder,
    ipsPageSearch: wsPageSearch,
    trackLastMessage: false,
    enabled: wsPageEnabled,
    onMessage: useCallback(
      (stats: StatsSummary) => {
        const query = stats.ipsPageQuery;
        const page = stats.ipsPage;
        if (!page || !query) return;

        setWsIPsPage({
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

  const wsIPsPageMatchesCurrent =
    wsIPsPage !== null &&
    wsIPsPage.backendId === activeBackendId &&
    wsIPsPage.query.offset === pageOffset &&
    wsIPsPage.query.limit === pageSize &&
    (wsIPsPage.query.sortBy || "totalDownload") === sortKey &&
    (wsIPsPage.query.sortOrder || "desc") === sortOrder &&
    (wsIPsPage.query.search || undefined) === wsPageSearch;

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

  const ipsQuery = useQuery({
    queryKey: getIPsQueryKey(
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
      api.getIPs(activeBackendId, {
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
      (!wsPageEnabled || wsPageStatus !== "connected" || !wsIPsPageMatchesCurrent),
    placeholderData: keepPreviousData,
  });

  const hasWsIPsPage =
    wsPageEnabled && wsPageStatus === "connected" && wsIPsPageMatchesCurrent;
  const data = hasWsIPsPage ? wsIPsPage.data : ipsQuery.data?.data ?? [];
  const total = hasWsIPsPage ? wsIPsPage.total : ipsQuery.data?.total ?? 0;
  const loading = !hasWsIPsPage && ipsQuery.isLoading && !ipsQuery.data;

  const handleSortChange = useCallback(
    (key: IPSortKey) => {
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
    <IPStatsTable
      ips={data}
      loading={loading}
      title={t("title")}
      showHeader
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
