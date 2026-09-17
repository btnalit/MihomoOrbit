"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  apiErrorCode,
  apiUpstreamStatus,
  coreReload,
  coreRestart,
  fetchManagementGroups,
  fetchProviders,
  fetchRuntimeConfig,
  flushDnsCache,
  flushFakeipCache,
  killConnection,
  patchRuntimeConfig,
  refreshProvider,
  selectGroupProxy,
  testGroupDelay,
  type ManagementGroupsResponse,
  type ManagementProvidersResponse,
  type MihomoRuntimeConfig,
  type ProviderKind,
} from "@/lib/api";

const MANAGEMENT_GROUPS_KEY = "managementGroups";
const RUNTIME_CONFIG_KEY = "managementRuntimeConfig";
const MANAGEMENT_PROVIDERS_KEY = "managementProviders";

export function managementGroupsQueryKey(backendId: number | undefined) {
  return [MANAGEMENT_GROUPS_KEY, backendId] as const;
}

export function runtimeConfigQueryKey(backendId: number | undefined) {
  return [RUNTIME_CONFIG_KEY, backendId] as const;
}

export function managementProvidersQueryKey(backendId: number | undefined) {
  return [MANAGEMENT_PROVIDERS_KEY, backendId] as const;
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

/** Rule/proxy providers list (M1.5). Same 5s-floor polling convention as
 *  `useManagementGroups` — this page has no dedicated topic, REST only. */
export function useProviders(backendId: number | undefined) {
  return useQuery<ManagementProvidersResponse>({
    queryKey: managementProvidersQueryKey(backendId),
    queryFn: () => fetchProviders(backendId as number),
    enabled: backendId !== undefined,
    staleTime: 5_000,
  });
}

export function useRefreshProvider(backendId: number | undefined) {
  const t = useTranslations("management.errors");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ kind, name }: { kind: ProviderKind; name: string }) =>
      refreshProvider(backendId as number, kind, name),
    retry: false,
    onSuccess: () => {
      // See useSelectProxy's onSuccess above: keeps `isPending` true through
      // the actual refetch, not just the invalidation call — the row's
      // spinner should stay lit until the refreshed `updatedAt` has landed.
      return queryClient.invalidateQueries({ queryKey: managementProvidersQueryKey(backendId) });
    },
    onError: (error: Error) => {
      toast.error(error?.message || t("refreshProviderFailed"));
    },
  });
}

// ── Core ops (M4) ─────────────────────────────────────────────────────
// restart / reload / flush-dns / flush-fakeip. Capabilities, not settings
// (plan §2) — no query backs a "current value" for any of these, so unlike
// usePatchRuntimeConfig there's nothing to keep in sync beyond invalidating
// the surfaces a successful restart/reload actually changes.

/** Server error → `management.runtime.coreOps.*` i18n key. Mirrors
 *  use-config-editor.ts's `reportConfigError`: `error.message` is always
 *  the fetch-layer's generic "API Error <status>: <url>" string, never
 *  anything server-supplied, so a mapped code always wins over it.
 *  `CORE_BUSY` is the plan §2 invariant surfacing — collector rejects
 *  restart/reload with 409 while an agent config write-back
 *  (`ConfigCommandRepository.getInFlight`) is in flight, since a manual
 *  restart mid-write-back would make the write-back's health gate
 *  misread an external restart as its own rollback trigger. An upstream
 *  404 means the running core build doesn't implement the endpoint at
 *  all (flush routes are newer than some deployed mihomo versions). */
function reportCoreOpsError(
  error: unknown,
  t: ReturnType<typeof useTranslations>,
  fallbackKey: "restartFailed" | "reloadFailed" | "flushDnsFailed" | "flushFakeipFailed",
) {
  if (apiErrorCode(error) === "CORE_BUSY") {
    toast.error(t("errors.coreBusy"));
    return;
  }
  if (apiUpstreamStatus(error) === 404) {
    toast.error(t("errors.unsupported"));
    return;
  }
  toast.error(t(fallbackKey));
}

/** `POST core/restart`. Success always means the POST itself was accepted
 *  (200) — `recovered` (collector's own `/version` poll verdict, up to its
 *  15s cap) decides which toast fires and whether the three affected
 *  queries get invalidated at all.
 *
 *  Why trust `recovered` instead of a fixed client-side delay: zashboard's
 *  own restart flow (its `backendActions.ts`) just waits a fixed 500ms
 *  before refetching, because its restart is fast enough on the cores it
 *  targets. Ours isn't — the plan's live measurement against mihomo
 *  v1.19.30 put the real recovery window at ~3s (plan §1), and that number
 *  can vary further with config size or host load. A fixed client delay
 *  would either refetch too early (stale/erroring queries right after
 *  invalidation) or pad every restart with dead wait time. Collector
 *  already has to poll `/version` itself to answer `recovered` at all
 *  (§3 T1), so the frontend piggybacks on that authoritative answer
 *  instead of re-implementing its own timing guess. */
export function useCoreRestart(backendId: number | undefined) {
  const t = useTranslations("management.runtime.coreOps");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => coreRestart(backendId as number),
    retry: false,
    onSuccess: (result) => {
      if (!result.recovered) {
        // POST succeeded, core just hasn't answered `/version` again
        // within collector's 15s cap — not a mutation failure, so no
        // error toast and no invalidation (the stale cached data is
        // still more useful than nothing until the core actually
        // answers).
        toast.warning(t("restartNotRecovered"));
        return;
      }
      toast.success(t("restartSuccess"));
      // Returning the promise keeps `isPending` true through the actual
      // refetch, not just the invalidation call — same rationale as
      // useSelectProxy/useRefreshProvider above. A restart resets every
      // proxy-group selection and re-reads whatever `mode`/`log-level`/
      // `allow-lan` the fresh process now reports, so all three surfaces
      // the plan calls out (groups/runtimeConfig/providers) need a fresh
      // read, not just runtimeConfig.
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: managementGroupsQueryKey(backendId) }),
        queryClient.invalidateQueries({ queryKey: runtimeConfigQueryKey(backendId) }),
        queryClient.invalidateQueries({ queryKey: managementProvidersQueryKey(backendId) }),
      ]);
    },
    onError: (error) => reportCoreOpsError(error, t, "restartFailed"),
  });
}

/** `PUT /configs?reload=true` passthrough (see `coreReload` in lib/api.ts).
 *  No confirmation dialog (plan §3 T2) — reload re-reads the already-loaded
 *  config rather than dropping connections, so it doesn't carry restart's
 *  destructive weight. */
export function useCoreReload(backendId: number | undefined) {
  const t = useTranslations("management.runtime.coreOps");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => coreReload(backendId as number),
    retry: false,
    onSuccess: () => {
      toast.success(t("reloadSuccess"));
      // See useCoreRestart's onSuccess above for why these three specifically.
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: managementGroupsQueryKey(backendId) }),
        queryClient.invalidateQueries({ queryKey: runtimeConfigQueryKey(backendId) }),
        queryClient.invalidateQueries({ queryKey: managementProvidersQueryKey(backendId) }),
      ]);
    },
    onError: (error) => reportCoreOpsError(error, t, "reloadFailed"),
  });
}

/** `POST /cache/dns/flush`. Success-only toast — flushing the DNS cache
 *  changes no value any query here reads back, so there's nothing to
 *  invalidate (plan §3 T2: "两个 flush:仅成功 toast"). */
export function useFlushDnsCache(backendId: number | undefined) {
  const t = useTranslations("management.runtime.coreOps");

  return useMutation({
    mutationFn: () => flushDnsCache(backendId as number),
    retry: false,
    onSuccess: () => toast.success(t("flushDnsSuccess")),
    onError: (error) => reportCoreOpsError(error, t, "flushDnsFailed"),
  });
}

/** `POST /cache/fakeip/flush`. Same rationale as `useFlushDnsCache` above. */
export function useFlushFakeipCache(backendId: number | undefined) {
  const t = useTranslations("management.runtime.coreOps");

  return useMutation({
    mutationFn: () => flushFakeipCache(backendId as number),
    retry: false,
    onSuccess: () => toast.success(t("flushFakeipSuccess")),
    onError: (error) => reportCoreOpsError(error, t, "flushFakeipFailed"),
  });
}
