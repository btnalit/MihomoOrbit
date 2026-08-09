"use client";

/**
 * Runtime settings page (M1 task 8). Reads Mihomo's `GET /configs`
 * passthrough via `useRuntimeConfig` and exposes the three fields the M1
 * scope deliberately keeps minimal (m1-contracts.md / plan §4): `mode`
 * (rule/global/direct), `log-level`, `allow-lan`. Everything else on the
 * response (ports, core version if present) is read-only display.
 *
 * No optimistic UI: each control's displayed value is read straight off
 * `useRuntimeConfig`'s query data, never from local state. A successful
 * PATCH invalidates that query (inside `usePatchRuntimeConfig` itself),
 * which re-renders the control with the new server truth; a failed PATCH
 * leaves the query cache untouched (the control already shows the
 * pre-change value) and additionally forces a `refetch()` here so the
 * control re-syncs against current server state rather than a client-side
 * guess — covers the case where the value drifted from what we last read
 * for a reason unrelated to this failed attempt. The hook's own `onError`
 * already toasts; this only adds the refetch.
 *
 * Three separate `usePatchRuntimeConfig` instances (one per control), not
 * one shared mutation — so "disable the control while its own patch is
 * pending" (task-8 brief) means exactly that: changing the mode segmented
 * control doesn't grey out the log-level select or the allow-lan switch
 * while its PATCH is in flight, and vice versa. Each control's `disabled`
 * also OR's in `configQuery.isFetching`, not just its own `isPending`, as a
 * belt-and-suspenders measure: `usePatchRuntimeConfig`'s `onSuccess`
 * (`use-management.ts`) now `return`s `invalidateQueries()`, so React Query
 * itself holds `isPending` true until the refetch settles — but keeping the
 * `isFetching` OR here costs nothing and also covers a refetch triggered by
 * something other than this mutation (e.g. a manual retry) landing in the
 * same window.
 *
 * Top warning banner (`NotPersistedBanner`) is resident on every render
 * branch — loading skeleton, hard error, offline-with-no-data, and the
 * normal loaded view — not just the happy path. `key={activeBackendId}`
 * remounts this page on every backend switch (see the dashboard dispatch),
 * so `isLoading` is true on every single visit; a banner gated behind the
 * loaded branch would be off-screen exactly when a user first lands here,
 * contradicting the brief's hard requirement (规格 §4 不持久标注).
 */

import { useTranslations } from "next-intl";
import { AlertTriangle, Info, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { apiErrorCode, isUnreachableError } from "@/lib/api";
import { useRuntimeConfig, usePatchRuntimeConfig } from "@/hooks/api/use-management";

const MODES = ["rule", "global", "direct"] as const;
type Mode = (typeof MODES)[number];

const LOG_LEVELS = ["debug", "info", "warning", "error", "silent"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function isKnownMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function isKnownLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

function formatPort(value: unknown): string {
  return typeof value === "number" && value > 0 ? String(value) : "—";
}

interface RuntimePageProps {
  backendId: number | undefined;
}

export function RuntimePage({ backendId }: RuntimePageProps) {
  const t = useTranslations("management.runtime");

  const configQuery = useRuntimeConfig(backendId);
  // See file header: independent mutation instances so pending-state is
  // per-control, not global across the three editable fields.
  const modePatch = usePatchRuntimeConfig(backendId);
  const logLevelPatch = usePatchRuntimeConfig(backendId);
  const allowLanPatch = usePatchRuntimeConfig(backendId);

  const handleRetry = () => {
    configQuery.refetch();
  };

  const unreachable = configQuery.isError && isUnreachableError(configQuery.error);
  const unauthorized =
    configQuery.isError && apiErrorCode(configQuery.error) === "UPSTREAM_UNAUTHORIZED";
  const showOfflineBanner = unreachable || unauthorized;
  const hasData = !!configQuery.data;

  // See file header: holds every control disabled through the un-awaited
  // invalidate-then-refetch window after a successful PATCH, not just
  // while the mutation itself is in flight.
  const controlsBusy = configQuery.isFetching;

  let body: React.ReactNode;

  if (configQuery.isLoading) {
    body = <RuntimePageSkeleton />;
  } else if (configQuery.isError && !showOfflineBanner && !hasData) {
    // Any other query error (not the documented unreachable-backend shape,
    // and not the upstream-rejected-credentials shape handled below) —
    // ManagementGate already filters out the 404/409 cases, but don't
    // render nothing if some other failure slips through.
    body = (
      <div
        role="alert"
        className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-3"
      >
        <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-destructive">{t("loadError")}</p>
          <p className="text-[13px] text-muted-foreground mt-0.5 break-words">
            {(configQuery.error as Error)?.message}
          </p>
        </div>
      </div>
    );
  } else if (showOfflineBanner && !hasData) {
    body = (
      <OfflineBanner
        onRetry={handleRetry}
        retrying={configQuery.isRefetching}
        unauthorized={unauthorized}
        fullPage
      />
    );
  } else {
    const data = configQuery.data;
    const mode = isKnownMode(data?.mode) ? data?.mode : undefined;
    const logLevel = isKnownLogLevel(data?.["log-level"]) ? data?.["log-level"] : undefined;
    const allowLan = !!data?.["allow-lan"];
    const version = typeof data?.version === "string" ? data.version : undefined;

    body = (
      <>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Settings2 className="w-5 h-5" />
          {t("title")}
        </h2>

        {showOfflineBanner && (
          <OfflineBanner
            onRetry={handleRetry}
            retrying={configQuery.isRefetching}
            unauthorized={unauthorized}
          />
        )}

        <Card>
          <CardContent className="p-5 space-y-5">
            <SettingRow label={t("mode.label")}>
              <div
                role="group"
                aria-label={t("mode.label")}
                className="inline-flex items-center gap-0.5 bg-muted/50 rounded-lg p-0.5"
              >
                {MODES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    disabled={modePatch.isPending || controlsBusy}
                    onClick={() => {
                      if (mode === m || modePatch.isPending) return;
                      modePatch.mutate(
                        { mode: m },
                        { onError: () => configQuery.refetch() },
                      );
                    }}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed",
                      mode === m
                        ? "bg-background shadow-sm text-primary"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`mode.${m}`)}
                  </button>
                ))}
              </div>
            </SettingRow>

            <SettingRow label={t("logLevel.label")}>
              <Select
                value={logLevel}
                disabled={logLevelPatch.isPending || controlsBusy}
                onValueChange={(value) => {
                  if (value === logLevel) return;
                  logLevelPatch.mutate(
                    { "log-level": value },
                    { onError: () => configQuery.refetch() },
                  );
                }}
              >
                <SelectTrigger className="w-40" aria-label={t("logLevel.label")}>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {LOG_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {t(`logLevel.${level}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow label={t("allowLan.label")} description={t("allowLan.description")}>
              <Switch
                checked={allowLan}
                disabled={allowLanPatch.isPending || controlsBusy}
                aria-label={t("allowLan.label")}
                onCheckedChange={(checked) => {
                  allowLanPatch.mutate(
                    { "allow-lan": checked },
                    { onError: () => configQuery.refetch() },
                  );
                }}
              />
            </SettingRow>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <h3 className="text-sm font-medium text-muted-foreground mb-3">
              {t("readonly.title")}
            </h3>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Stat label={t("readonly.mixedPort")} value={formatPort(data?.["mixed-port"])} />
              <Stat label={t("readonly.port")} value={formatPort(data?.port)} />
              <Stat label={t("readonly.socksPort")} value={formatPort(data?.["socks-port"])} />
              {version && <Stat label={t("readonly.version")} value={version} />}
            </div>
          </CardContent>
        </Card>
      </>
    );
  }

  // NotPersistedBanner is resident on every branch above — see file header.
  return (
    <div className="space-y-4">
      <NotPersistedBanner />
      {body}
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

/** Always-visible, regardless of load/offline state — the non-persistence
 *  warning applies to the page's purpose itself (live-core edits, not
 *  saved config), not to any particular data-loading outcome. */
function NotPersistedBanner() {
  const t = useTranslations("management.runtime");
  return (
    <div
      role="status"
      className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 flex items-start gap-2.5"
    >
      <Info className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5" />
      <p className="text-sm text-sky-700 dark:text-sky-300">{t("notPersisted")}</p>
    </div>
  );
}

/** Duplicated (not extracted) from `groups-page.tsx`'s `OfflineBanner` —
 *  same visual/i18n pattern and manual-retry affordance, since this page is
 *  REST-backed (`useRuntimeConfig`) like groups, not topic-backed like
 *  connections/logs. */
function OfflineBanner({
  onRetry,
  retrying,
  fullPage,
  unauthorized,
}: {
  onRetry: () => void;
  retrying?: boolean;
  fullPage?: boolean;
  /** Upstream answered but rejected the api_secret (UPSTREAM_UNAUTHORIZED) —
   *  same banner shell, different message than the generic offline case. */
  unauthorized?: boolean;
}) {
  const t = useTranslations("management.runtime");
  const mt = useTranslations("management");

  const content = (
    <div
      role="alert"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex flex-wrap items-center justify-between gap-3"
    >
      <div className="flex items-center gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {unauthorized ? mt("upstreamUnauthorized") : t("offlineBanner")}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={retrying}
        className="gap-1.5"
      >
        <RefreshCw className={cn("w-3.5 h-3.5", retrying && "animate-spin")} />
        {t("retry")}
      </Button>
    </div>
  );

  if (!fullPage) return content;

  return <div className="flex items-center justify-center min-h-[50vh] p-4">{content}</div>;
}

function RuntimePageSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-6 w-40 rounded bg-muted/60 animate-pulse" />
      <div className="h-14 w-full rounded-xl bg-muted/30 animate-pulse" />
      <div className="rounded-xl border bg-card p-5 space-y-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between gap-3">
            <div className="h-4 w-24 rounded bg-muted/50 animate-pulse" />
            <div className="h-8 w-32 rounded bg-muted/40 animate-pulse" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border bg-card p-5">
        <div className="h-4 w-20 rounded bg-muted/50 animate-pulse mb-3" />
        <div className="h-4 w-full rounded bg-muted/30 animate-pulse" />
      </div>
    </div>
  );
}
