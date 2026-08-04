import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, type TimeRange } from "@/lib/api";
import {
  getDevicesQueryKey,
  getDeviceDomainsQueryKey,
  getDeviceIPsQueryKey,
} from "@/lib/stats-query-keys";
import { keepPreviousByIdentity } from "@/lib/query-placeholder";
import { QUERY_CONFIG } from "@/lib/query-config";

interface UseDevicesOptions {
  activeBackendId?: number;
  limit?: number;
  range?: TimeRange;
  enabled?: boolean;
}

export function useDevices({
  activeBackendId,
  limit = QUERY_CONFIG.LIMIT.DEFAULT,
  range,
  enabled = true,
}: UseDevicesOptions) {
  return useQuery({
    queryKey: getDevicesQueryKey(activeBackendId, limit, range),
    queryFn: () => api.getDevices(activeBackendId, limit, range),
    enabled: !!activeBackendId && enabled,
    placeholderData: keepPreviousData,
    staleTime: QUERY_CONFIG.STALE_TIME.REALTIME,
  });
}

interface UseDeviceDetailOptions {
  sourceIP?: string;
  activeBackendId?: number;
  range?: TimeRange;
  enabled?: boolean;
}

export function useDeviceDomains({
  sourceIP,
  activeBackendId,
  range,
  enabled = true,
}: UseDeviceDetailOptions) {
  return useQuery({
    queryKey: getDeviceDomainsQueryKey(sourceIP ?? null, activeBackendId, range),
    queryFn: () => {
      if (!sourceIP || !activeBackendId) throw new Error("Missing params");
      return api.getDeviceDomains(sourceIP, activeBackendId, range);
    },
    enabled: !!activeBackendId && !!sourceIP && enabled,
    placeholderData: (previousData, previousQuery) =>
      keepPreviousByIdentity(previousData, previousQuery, {
        sourceIP: sourceIP ?? "",
        backendId: activeBackendId ?? null,
      }),
  });
}

export function useDeviceIPs({
  sourceIP,
  activeBackendId,
  range,
  enabled = true,
}: UseDeviceDetailOptions) {
  return useQuery({
    queryKey: getDeviceIPsQueryKey(sourceIP ?? null, activeBackendId, range),
    queryFn: () => {
      if (!sourceIP || !activeBackendId) throw new Error("Missing params");
      return api.getDeviceIPs(sourceIP, activeBackendId, range);
    },
    enabled: !!activeBackendId && !!sourceIP && enabled,
    placeholderData: (previousData, previousQuery) =>
      keepPreviousByIdentity(previousData, previousQuery, {
        sourceIP: sourceIP ?? "",
        backendId: activeBackendId ?? null,
      }),
  });
}
