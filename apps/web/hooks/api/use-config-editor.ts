"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  apiErrorCode,
  applyConfig,
  fetchConfigCurrent,
  fetchConfigVersions,
  fetchLatestCommand,
  revealConfigValue,
  rollbackConfig,
  type ConfigCurrent,
  type ConfigVersionMeta,
  type LatestCommandResponse,
} from "@/lib/api";

const CONFIG_CURRENT_KEY = "configCurrent";
const CONFIG_VERSIONS_KEY = "configVersions";
const CONFIG_LATEST_COMMAND_KEY = "configLatestCommand";

export function configCurrentQueryKey(backendId: number | undefined) {
  return [CONFIG_CURRENT_KEY, backendId] as const;
}

export function configVersionsQueryKey(backendId: number | undefined) {
  return [CONFIG_VERSIONS_KEY, backendId] as const;
}

export function configLatestCommandQueryKey(backendId: number | undefined) {
  return [CONFIG_LATEST_COMMAND_KEY, backendId] as const;
}

/** Server error `code` (from `apiErrorCode()`) → `configEditor.errors.*`
 *  i18n key. Codes not listed here fall back to the caller's generic
 *  message. `NO_CONFIG_EDIT_CAPABILITY` is deliberately excluded —
 *  `ConfigEditGate` keeps these mutations from ever being reachable
 *  without the capability, so surfacing it here would only mean the gate
 *  itself has a bug, not something a user-facing toast should explain. */
const ERROR_CODE_KEYS: Record<string, string> = {
  YAML_INVALID: "yamlInvalid",
  MASK_PATH_MISSING: "maskPathMissing",
  SELF_LOCK_FIELD_CHANGED: "selfLockFieldChanged",
  BASE_HASH_STALE: "baseHashStale",
  CONFIG_COMMAND_IN_FLIGHT: "commandInFlight",
  UNSUPPORTED_GATEWAY: "unsupportedGateway",
  NO_CONFIG_REPORTED: "noConfigReported",
  VERSION_NOT_FOUND: "versionNotFound",
};

/** `ApiError.message` is always truthy (`"API Error 404: <url>"` — the
 *  fetch-layer message, not anything server-supplied) — never fall back to
 *  it in a user-facing toast, or an unmapped code (e.g. `PATH_NOT_MASKED`)
 *  renders a raw URL instead of a localized message. Mapped codes use
 *  their specific i18n key; everything else uses the caller's localized
 *  generic fallback, never `error.message`. */
function reportConfigError(
  error: unknown,
  t: ReturnType<typeof useTranslations>,
  fallbackKey: "applyFailed" | "rollbackFailed" | "revealFailed",
) {
  const code = apiErrorCode(error);
  const mappedKey = code ? ERROR_CODE_KEYS[code] : undefined;
  toast.error(t(mappedKey ?? fallbackKey));
}

/** Latest masked config content + hash for the editor's base state. */
export function useConfigCurrent(backendId: number | undefined) {
  return useQuery<ConfigCurrent>({
    queryKey: configCurrentQueryKey(backendId),
    queryFn: () => fetchConfigCurrent(backendId as number),
    enabled: backendId !== undefined,
    staleTime: 5_000,
  });
}

export function useConfigVersions(backendId: number | undefined) {
  return useQuery<{ versions: ConfigVersionMeta[] }>({
    queryKey: configVersionsQueryKey(backendId),
    queryFn: () => fetchConfigVersions(backendId as number),
    enabled: backendId !== undefined,
  });
}

export function useApplyConfig(backendId: number | undefined) {
  const t = useTranslations("configEditor.errors");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: { content: string; baseHash: string }) =>
      applyConfig(backendId as number, body),
    retry: false,
    onSuccess: () => {
      // Await both invalidations like useSelectProxy/usePatchRuntimeConfig
      // (use-management.ts) do — keeps `isPending` true through the actual
      // refetch, and the latest-command query needs to pick up the new
      // in-flight command right away for the polling flow (Task 11).
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: configCurrentQueryKey(backendId) }),
        queryClient.invalidateQueries({ queryKey: configVersionsQueryKey(backendId) }),
        queryClient.invalidateQueries({ queryKey: configLatestCommandQueryKey(backendId) }),
      ]);
    },
    onError: (error: Error) => reportConfigError(error, t, "applyFailed"),
  });
}

export function useRollbackConfig(backendId: number | undefined) {
  const t = useTranslations("configEditor.errors");
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (versionId: number) => rollbackConfig(backendId as number, versionId),
    retry: false,
    onSuccess: () => {
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: configCurrentQueryKey(backendId) }),
        queryClient.invalidateQueries({ queryKey: configVersionsQueryKey(backendId) }),
        queryClient.invalidateQueries({ queryKey: configLatestCommandQueryKey(backendId) }),
      ]);
    },
    onError: (error: Error) => reportConfigError(error, t, "rollbackFailed"),
  });
}

/** Polls the in-flight command's state while `poll` is true (i.e. right
 *  after an apply/rollback, until it reaches a terminal state or expires —
 *  Task 11 owns turning `poll` off). */
export function useLatestCommand(
  backendId: number | undefined,
  opts: { poll: boolean },
) {
  return useQuery<LatestCommandResponse>({
    queryKey: configLatestCommandQueryKey(backendId),
    queryFn: () => fetchLatestCommand(backendId as number),
    enabled: backendId !== undefined,
    refetchInterval: opts.poll ? 3_000 : false,
  });
}

/** Reveals the plaintext value at a masked path. Caller owns keeping the
 *  result out of any persistent store (component state only, cleared on
 *  blur/navigation) — this hook does not cache it in React Query. */
export function useRevealValue(backendId: number | undefined) {
  const t = useTranslations("configEditor.errors");

  return useMutation({
    mutationFn: (path: string) => revealConfigValue(backendId as number, path),
    retry: false,
    onError: (error: Error) => reportConfigError(error, t, "revealFailed"),
  });
}
