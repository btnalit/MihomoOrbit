"use client";

/**
 * Providers management page (M1.5). Two REST-backed sections over
 * `useProviders` — rule providers (behavior + rule count) and proxy
 * providers (member count) — each merged and Compatible-filtered
 * server-side by `management.service.ts`'s `fetchProviders` (inline-group
 * noise, not real file/URL-backed providers, never reaches this page).
 *
 * Per-row refresh mirrors `connections-page.tsx`'s `killingIds` pattern: a
 * `Set<string>` of in-flight `${kind}:${name}` keys (not a single string),
 * so two quick refreshes on different rows each keep their own spinner
 * instead of the second click clobbering the first's pending state. A
 * successful refresh invalidates the whole `useProviders` query (inside
 * `useRefreshProvider` itself) so the row's `updatedAt` reflects the
 * upstream re-fetch once it lands.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Database, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn, formatDuration } from "@/lib/utils";
import {
  apiErrorCode,
  isUnreachableError,
  type ProviderKind,
  type ProxyProviderInfo,
  type RuleProviderInfo,
} from "@/lib/api";
import { useProviders, useRefreshProvider } from "@/hooks/api/use-management";

interface ProvidersPageProps {
  backendId: number | undefined;
}

export function ProvidersPage({ backendId }: ProvidersPageProps) {
  const t = useTranslations("management.providers");

  const providersQuery = useProviders(backendId);
  const refreshProvider = useRefreshProvider(backendId);
  const [refreshingKeys, setRefreshingKeys] = useState<Set<string>>(new Set());

  const handleRefresh = (kind: ProviderKind, name: string) => {
    const key = `${kind}:${name}`;
    setRefreshingKeys((prev) => new Set(prev).add(key));
    refreshProvider.mutate(
      { kind, name },
      {
        onSettled: () => {
          setRefreshingKeys((prev) => {
            if (!prev.has(key)) return prev;
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        },
      },
    );
  };

  const handleRetry = () => {
    providersQuery.refetch();
  };

  const unreachable = providersQuery.isError && isUnreachableError(providersQuery.error);
  const unauthorized =
    providersQuery.isError && apiErrorCode(providersQuery.error) === "UPSTREAM_UNAUTHORIZED";
  const showOfflineBanner = unreachable || unauthorized;
  const hasData = !!providersQuery.data;

  if (providersQuery.isLoading) {
    return <ProvidersPageSkeleton />;
  }

  // Any other query error (not the documented unreachable-backend shape, and
  // not the upstream-rejected-credentials shape handled below) — rare in
  // practice since ManagementGate already filters out the 404/409 cases, but
  // don't render nothing if it happens.
  if (providersQuery.isError && !showOfflineBanner && !hasData) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-3"
      >
        <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-destructive">{t("loadError")}</p>
          <p className="text-[13px] text-muted-foreground mt-0.5 break-words">
            {(providersQuery.error as Error)?.message}
          </p>
        </div>
      </div>
    );
  }

  if (showOfflineBanner && !hasData) {
    return (
      <OfflineBanner
        onRetry={handleRetry}
        retrying={providersQuery.isRefetching}
        unauthorized={unauthorized}
        fullPage
      />
    );
  }

  const ruleProviders = providersQuery.data?.ruleProviders ?? [];
  const proxyProviders = providersQuery.data?.proxyProviders ?? [];

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Database className="w-5 h-5" />
        {t("title")}
      </h2>

      {showOfflineBanner && (
        <OfflineBanner
          onRetry={handleRetry}
          retrying={providersQuery.isRefetching}
          unauthorized={unauthorized}
        />
      )}

      <ProviderSection title={t("ruleProviders")} isEmpty={ruleProviders.length === 0} emptyText={t("empty")}>
        {ruleProviders.map((p) => (
          <RuleProviderRow
            key={p.name}
            provider={p}
            refreshing={refreshingKeys.has(`rule:${p.name}`)}
            onRefresh={() => handleRefresh("rule", p.name)}
          />
        ))}
      </ProviderSection>

      <ProviderSection title={t("proxyProviders")} isEmpty={proxyProviders.length === 0} emptyText={t("empty")}>
        {proxyProviders.map((p) => (
          <ProxyProviderRow
            key={p.name}
            provider={p}
            refreshing={refreshingKeys.has(`proxy:${p.name}`)}
            onRefresh={() => handleRefresh("proxy", p.name)}
          />
        ))}
      </ProviderSection>
    </div>
  );
}

function ProviderSection({
  title,
  isEmpty,
  emptyText,
  children,
}: {
  title: string;
  isEmpty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <Card>
        <CardContent className="p-0">
          {isEmpty ? (
            <div className="text-center py-8 text-sm text-muted-foreground">{emptyText}</div>
          ) : (
            <div className="divide-y divide-border">{children}</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RuleProviderRow({
  provider,
  refreshing,
  onRefresh,
}: {
  provider: RuleProviderInfo;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations("management.providers");
  return (
    <ProviderRow
      name={provider.name}
      detail={t("ruleDetail", { behavior: provider.behavior, count: provider.ruleCount })}
      updatedAt={provider.updatedAt}
      vehicleType={provider.vehicleType}
      refreshing={refreshing}
      onRefresh={onRefresh}
    />
  );
}

function ProxyProviderRow({
  provider,
  refreshing,
  onRefresh,
}: {
  provider: ProxyProviderInfo;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations("management.providers");
  return (
    <ProviderRow
      name={provider.name}
      detail={t("proxyDetail", { count: provider.proxyCount })}
      updatedAt={provider.updatedAt}
      vehicleType={provider.vehicleType}
      refreshing={refreshing}
      onRefresh={onRefresh}
    />
  );
}

function ProviderRow({
  name,
  detail,
  updatedAt,
  vehicleType,
  refreshing,
  onRefresh,
}: {
  name: string;
  detail: string;
  updatedAt: string;
  vehicleType: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations("management.providers");
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium truncate" title={name}>
          {name}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          {detail} · {formatDuration(updatedAt)}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge variant="outline" className="text-[11px] uppercase tracking-wide">
          {vehicleType}
        </Badge>
        <Button
          variant="outline"
          size="icon-sm"
          className="h-7 w-7"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={t("refresh")}
          title={t("refresh")}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
        </Button>
      </div>
    </div>
  );
}

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
  const t = useTranslations("management.providers");
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

function ProvidersPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-6 w-32 rounded bg-muted/60 animate-pulse" />
      {[0, 1].map((section) => (
        <div key={section} className="space-y-2">
          <div className="h-4 w-24 rounded bg-muted/50 animate-pulse" />
          <div className="rounded-xl border bg-card shadow-xs p-4 space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-8 w-full rounded bg-muted/40 animate-pulse" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
