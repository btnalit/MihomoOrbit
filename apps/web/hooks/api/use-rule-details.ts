import { useQuery } from "@tanstack/react-query";
import { api, type TimeRange } from "@/lib/api";
import {
  getDomainProxyStatsQueryKey,
  getDomainIPDetailsQueryKey,
  getIPProxyStatsQueryKey,
  getIPDomainDetailsQueryKey,
} from "@/lib/stats-query-keys";
import { keepPreviousByIdentity } from "@/lib/query-placeholder";
import { QUERY_CONFIG } from "@/lib/query-config";

interface UseRuleExtendedStatsOptions {
  rule: string | undefined;
  activeBackendId?: number;
  range?: TimeRange;
  enabled?: boolean;
}

interface UseRuleDomainStatsOptions extends UseRuleExtendedStatsOptions {
  domain: string | undefined;
}

interface UseRuleIPStatsOptions extends UseRuleExtendedStatsOptions {
  ip: string | undefined;
}

export function useRuleDomainProxyStats({
  rule,
  domain,
  activeBackendId,
  range,
  enabled = true,
}: UseRuleDomainStatsOptions) {
  return useQuery({
    queryKey: getDomainProxyStatsQueryKey(domain ?? null, activeBackendId, range, {
      rule,
    }),
    queryFn: () =>
      api.getRuleDomainProxyStats(
        rule!,
        domain!,
        activeBackendId,
        range,
      ),
    enabled: !!activeBackendId && !!rule && !!domain && enabled,
    staleTime: QUERY_CONFIG.STALE_TIME.DETAIL,
    placeholderData: (previousData, previousQuery) =>
      keepPreviousByIdentity(previousData, previousQuery, {
        domain: domain ?? "",
        backendId: activeBackendId ?? null,
        rule: rule ?? "",
      }),
  });
}

export function useRuleDomainIPDetails({
  rule,
  domain,
  activeBackendId,
  range,
  enabled = true,
}: UseRuleDomainStatsOptions) {
  return useQuery({
    queryKey: getDomainIPDetailsQueryKey(domain ?? null, activeBackendId, range, {
      rule,
    }),
    queryFn: () =>
      api.getRuleDomainIPDetails(
        rule!,
        domain!,
        activeBackendId,
        range,
      ),
    enabled: !!activeBackendId && !!rule && !!domain && enabled,
    staleTime: QUERY_CONFIG.STALE_TIME.DETAIL,
    placeholderData: (previousData, previousQuery) =>
      keepPreviousByIdentity(previousData, previousQuery, {
        domain: domain ?? "",
        backendId: activeBackendId ?? null,
        rule: rule ?? "",
      }),
  });
}

export function useRuleIPProxyStats({
  rule,
  ip,
  activeBackendId,
  range,
  enabled = true,
}: UseRuleIPStatsOptions) {
  return useQuery({
    queryKey: getIPProxyStatsQueryKey(ip ?? null, activeBackendId, range, {
      rule,
    }),
    queryFn: () =>
      api.getRuleIPProxyStats(
        rule!,
        ip!,
        activeBackendId,
        range,
      ),
    enabled: !!activeBackendId && !!rule && !!ip && enabled,
    staleTime: QUERY_CONFIG.STALE_TIME.DETAIL,
    placeholderData: (previousData, previousQuery) =>
      keepPreviousByIdentity(previousData, previousQuery, {
        ip: ip ?? "",
        backendId: activeBackendId ?? null,
        rule: rule ?? "",
      }),
  });
}

export function useRuleIPDomainDetails({
  rule,
  ip,
  activeBackendId,
  range,
  enabled = true,
}: UseRuleIPStatsOptions) {
  return useQuery({
    queryKey: getIPDomainDetailsQueryKey(ip ?? null, activeBackendId, range, {
      rule,
    }),
    queryFn: () =>
      api.getRuleIPDomainDetails(
        rule!,
        ip!,
        activeBackendId,
        range,
      ),
    enabled: !!activeBackendId && !!rule && !!ip && enabled,
    staleTime: QUERY_CONFIG.STALE_TIME.DETAIL,
    placeholderData: (previousData, previousQuery) =>
      keepPreviousByIdentity(previousData, previousQuery, {
        ip: ip ?? "",
        backendId: activeBackendId ?? null,
        rule: rule ?? "",
      }),
  });
}
