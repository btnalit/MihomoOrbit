"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  apiErrorCode,
  fetchManagementGroups,
  fetchRuntimeConfig,
  killConnection,
  patchRuntimeConfig,
  selectGroupProxy,
  testGroupDelay,
  type ManagementGroupsResponse,
  type MihomoRuntimeConfig,
} from "@/lib/api";

const MANAGEMENT_GROUPS_KEY = "managementGroups";
const RUNTIME_CONFIG_KEY = "managementRuntimeConfig";

export function managementGroupsQueryKey(backendId: number | undefined) {
  return [MANAGEMENT_GROUPS_KEY, backendId] as const;
}

export function runtimeConfigQueryKey(backendId: number | undefined) {
  return [RUNTIME_CONFIG_KEY, backendId] as const;
}

/** Proxy groups + member proxies. Polled at a 5s floor — live updates for
 *  the `delay` topic still arrive over `useTopicSubscription`. */
export function useManagementGroups(backendId: number | undefined) {
  return useQuery<ManagementGroupsResponse>({
    queryKey: managementGroupsQueryKey(backendId),
    queryFn: () => fetchManagementGroups(backendId as number),
    enabled: backendId !== undefined,
    staleTime: 5_000,
  });
}

export function useSelectProxy(backendId: number | undefined) {
  const t = useTranslations("management.errors");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ group, proxy }: { group: string; proxy: string }) =>
      selectGroupProxy(backendId as number, group, proxy),
    retry: false,
    onSuccess: () => {
      // React Query awaits promises returned from onSuccess before settling
      // the mutation — returning this keeps `isPending` true until the
      // refetch itself lands, not just until the invalidation is scheduled.
      return queryClient.invalidateQueries({ queryKey: managementGroupsQueryKey(backendId) });
    },
    onError: (error: Error) => {
      toast.error(error?.message || t("selectProxyFailed"));
    },
  });
}

export function useGroupDelayTest(backendId: number | undefined) {
  const t = useTranslations("management.errors");
  const mt = useTranslations("management");

  return useMutation({
    mutationFn: ({
      group,
      opts,
    }: {
      group: string;
      opts?: { url?: string; timeout?: number };
    }) => testGroupDelay(backendId as number, group, opts),
    retry: false,
    onError: (error: Error) => {
      // A duplicate POST for a group that's already testing is a 409
      // DELAY_TEST_RUNNING, not a failure — the original test's results
      // still land on the `delay` topic. Surface that distinctly instead
      // of a generic "failed" toast.
      if (apiErrorCode(error) === "DELAY_TEST_RUNNING") {
        toast.error(mt("delayTestRunning"));
        return;
      }
      toast.error(error?.message || t("delayTestFailed"));
    },
  });
}

export function useKillConnection(backendId: number | undefined) {
  const t = useTranslations("management.errors");

  return useMutation({
    mutationFn: (connId: string) => killConnection(backendId as number, connId),
    retry: false,
    onError: (error: Error) => {
      toast.error(error?.message || t("killConnectionFailed"));
    },
  });
}

/** Mihomo `/configs` passthrough. */
export function useRuntimeConfig(backendId: number | undefined) {
  return useQuery<MihomoRuntimeConfig>({
    queryKey: runtimeConfigQueryKey(backendId),
    queryFn: () => fetchRuntimeConfig(backendId as number),
    enabled: backendId !== undefined,
  });
}

export function usePatchRuntimeConfig(backendId: number | undefined) {
  const t = useTranslations("management.errors");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patch: Partial<MihomoRuntimeConfig>) =>
      patchRuntimeConfig(backendId as number, patch),
    retry: false,
    onSuccess: () => {
      // See useSelectProxy's onSuccess above: returning the promise keeps
      // `isPending` true through the actual refetch, not just the
      // invalidation call.
      return queryClient.invalidateQueries({ queryKey: runtimeConfigQueryKey(backendId) });
    },
    onError: (error: Error) => {
      toast.error(error?.message || t("patchConfigFailed"));
    },
  });
}
