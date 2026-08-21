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
  type ConfigCommandState,
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
 *  generic fallback, never `error.message`.
 *
 *  `silentCodes` (M2b Task 10 review fix, Finding 1): TanStack Query v5
 *  fires BOTH this hook-level `onError` (baked into `useMutation(...)`
 *  itself) AND any per-call `mutate(vars, { onError })` handler — a caller
 *  that owns its own dedicated UI for a specific code (e.g.
 *  apply-dialog.tsx switching to a conflict card for `BASE_HASH_STALE`)
 *  would otherwise ALSO get this generic mapped toast firing at the exact
 *  same moment, both describing the same failure. Codes listed in
 *  `silentCodes` skip the toast here entirely — the caller is asserting it
 *  already has a dedicated, more actionable UI for them. Every other code
 *  is unaffected. */
function reportConfigError(
  error: unknown,
  t: ReturnType<typeof useTranslations>,
  fallbackKey: "applyFailed" | "rollbackFailed" | "revealFailed",
  silentCodes?: string[],
) {
  const code = apiErrorCode(error);
  if (code && silentCodes?.includes(code)) return;
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

/** `options.silentCodes` — see `reportConfigError`'s doc comment. Passed by
 *  apply-dialog.tsx as `['BASE_HASH_STALE', 'MASK_PATH_MISSING']` since it
 *  owns dedicated UI for both (a conflict card and an inline
 *  renamed-masked-row explanation, respectively) — this hook's own mapped
 *  toast would otherwise fire redundantly at the same instant. */
export function useApplyConfig(
  backendId: number | undefined,
  options?: { silentCodes?: string[] },
) {
  const t = useTranslations("configEditor.errors");
  const queryClient = useQueryClient();
  const silentCodes = options?.silentCodes;

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
    onError: (error: Error) => reportConfigError(error, t, "applyFailed", silentCodes),
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

/** Command states that will never change again — a command reaching one of
 *  these is exactly what stops polling below (mirrors the collector's own
 *  `IN_FLIGHT_STATES = ['pending', 'dispatched']` in
 *  config-command.repository.ts, from the terminal side). */
const TERMINAL_COMMAND_STATES = new Set<ConfigCommandState>([
  "applied",
  "conflict",
  "rolled-back",
  "failed",
]);

/** Polls the in-flight command's state while `opts.poll` is true — Task 11.
 *
 *  The actual refetch FREQUENCY is a `refetchInterval` FUNCTION (TanStack
 *  Query v5 supports `(query) => number | false`, evaluated against the
 *  query's own latest `state.data` on every check), not a caller-managed
 *  boolean flipped from the outside — that avoids the exact
 *  chicken-and-egg problem a static boolean would create (the decision to
 *  keep polling depends on the LATEST fetched command, which is this same
 *  query's own data). Polling stops the instant the latest command is
 *  `null`, reaches a `TERMINAL_COMMAND_STATES` member, or is `expired`
 *  (the collector's `isExpired` — config-command.repository.ts — only ever
 *  returns true for `pending`/`dispatched`, so terminal+expired can't
 *  co-occur, but the check is written defensively regardless). Callers
 *  (command-timeline.tsx) just pass `poll: true` unconditionally and this
 *  hook stops itself — no component-level state machine needed. */
export function useLatestCommand(
  backendId: number | undefined,
  opts: { poll: boolean },
) {
  return useQuery<LatestCommandResponse>({
    queryKey: configLatestCommandQueryKey(backendId),
    queryFn: () => fetchLatestCommand(backendId as number),
    enabled: backendId !== undefined,
    refetchInterval: opts.poll
      ? (query) => {
          const command = query.state.data?.command;
          if (!command) return false;
          if (TERMINAL_COMMAND_STATES.has(command.state)) return false;
          if (command.expired) return false;
          return 3_000;
        }
      : false,
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
