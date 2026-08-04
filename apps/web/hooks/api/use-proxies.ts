import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, type TimeRange } from "@/lib/api";
import {
  getProxiesQueryKey,
  getProxyDomainsQueryKey,
  getProxyIPsQueryKey
} from "@/lib/stats-query-keys";
import { keepPreviousByIdentity } from "@/lib/query-placeholder";
import { QUERY_CONFIG } from "@/lib/query-config";

interface UseProxiesOptions {
  activeBackendId?: number;
  limit?: number;
  range?: TimeRange;
  enabled?: boolean;
}

export function useProxies({
  activeBackendId,
  limit = QUERY_CONFIG.LIMIT.DEFAULT,
  range,
  enabled = true,
}: UseProxiesOptions) {
  return useQuery({
    queryKey: getProxiesQueryKey(activeBackendId, limit, range),
    queryFn: () => api.getProxies(activeBackendId, limit, range),
    enabled: !!activeBackendId && enabled,
    placeholderData: keepPreviousData,
    staleTime: QUERY_CONFIG.STALE_TIME.REALTIME,
  });
}

interface UseProxyDetailsOptions {
  chain: string | null;
  activeBackendId?: number;
  range?: TimeRange;
  enabled?: boolean;
}

export function useProxyDomains({
  chain,
  activeBackendId,
  range,
  enabled = true,
}: UseProxyDetailsOptions) {
  return useQuery({
    queryKey: getProxyDomainsQueryKey(chain, activeBackendId, range),
    queryFn: () => api.getProxyDomains(chain!, activeBackendId, range, QUERY_CONFIG.LIMIT.DETAIL),
    enabled: !!activeBackendId && !!chain && enabled,
    staleTime: QUERY_CONFIG.STALE_TIME.DETAIL,
    placeholderData: (previousData, previousQuery) =>
      keepPreviousByIdentity(previousData, previousQuery, {
        chain: chain ?? "",
        backendId: activeBackendId ?? null,
      }),
  });
}

export function useProxyIPs({
  chain,
  activeBackendId,
  range,
  enabled = true,
}: UseProxyDetailsOptions) {
  return useQuery({
    queryKey: getProxyIPsQueryKey(chain, activeBackendId, range),
    queryFn: () => api.getProxyIPs(chain!, activeBackendId, range, QUERY_CONFIG.LIMIT.DETAIL),
    enabled: !!activeBackendId && !!chain && enabled,
    staleTime: QUERY_CONFIG.STALE_TIME.DETAIL,
    placeholderData: (previousData, previousQuery) =>
      keepPreviousByIdentity(previousData, previousQuery, {
        chain: chain ?? "",
        backendId: activeBackendId ?? null,
      }),
  });
}
