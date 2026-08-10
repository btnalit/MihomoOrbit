"use client";

/**
 * M2b Task 8 — metadata-driven config editor. Renders one Tab per
 * config-metadata.json category: the 5 flat categories (basic/network/tun/
 * dns/sniffer) are fully editable here via `useConfigForm` + `FieldRenderer`;
 * the 3 table categories (proxies/proxy-groups/rules) show a placeholder —
 * Task 9 replaces it with a real row-based table editor.
 *
 * No submit/apply/preview affordance lives here on purpose — Task 10 owns
 * the YAML preview, diff, and apply/conflict flow, consuming
 * `useConfigForm`'s live `document`. This page's job stops at loading state
 * + correct, dirty-tracked form state that maps 1:1 onto the parsed YAML.
 *
 * M2b Task 9: the 3 `isTable` categories now render `ConfigTableEditor`
 * (config-table-editor.tsx) instead of the placeholder Task 8 left in
 * their place.
 *
 * Data flow (brief, binding): `useConfigCurrent` -> `yaml.parse
 * (maskedContent)` (inside `useConfigForm`) -> form state. Two distinct
 * empty states, per the brief: `current.parseError === true` (server
 * couldn't parse/mask the on-disk config) vs a 404 `NO_CONFIG_REPORTED`
 * query error (the agent hasn't reported a config file for this backend at
 * all yet) — these are different failure modes and get different copy.
 */

import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  FileWarning,
  Globe,
  Layers,
  ListChecks,
  Network,
  RefreshCw,
  ScanSearch,
  Settings2,
  Share2,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { apiErrorCode, isUnreachableError } from "@/lib/api";
import { useConfigCurrent } from "@/hooks/api/use-config-editor";
import { FieldRenderer } from "./field-renderer";
import { ConfigTableEditor } from "./config-table-editor";
import { useConfigForm, type UseConfigFormResult } from "./use-config-form";
import type { ConfigMetadata, FlatCategory } from "@/lib/types/config-metadata";

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  basic: Settings2,
  network: Network,
  tun: Share2,
  dns: Globe,
  sniffer: ScanSearch,
  proxies: Waypoints,
  "proxy-groups": Layers,
  rules: ListChecks,
};

const CONFIG_METADATA_QUERY_KEY = ["configMetadata"] as const;

function useConfigMetadata() {
  return useQuery<ConfigMetadata>({
    queryKey: CONFIG_METADATA_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/config-metadata.json");
      if (!res.ok) {
        throw new Error(`config-metadata.json ${res.status}`);
      }
      return (await res.json()) as ConfigMetadata;
    },
    // Static build asset, byte-for-byte fixed per Task 7 — never refetch.
    staleTime: Infinity,
  });
}

interface ConfigEditorPageProps {
  backendId: number | undefined;
}

export function ConfigEditorPage({ backendId }: ConfigEditorPageProps) {
  const metadataQuery = useConfigMetadata();
  const currentQuery = useConfigCurrent(backendId);

  if (metadataQuery.isLoading || currentQuery.isLoading) {
    return <ConfigEditorSkeleton />;
  }

  if (metadataQuery.isError || !metadataQuery.data) {
    return <ConfigEditorLoadError onRetry={() => metadataQuery.refetch()} />;
  }

  if (currentQuery.isError) {
    if (apiErrorCode(currentQuery.error) === "NO_CONFIG_REPORTED") {
      return <ConfigEditorEmptyState variant="noConfig" />;
    }
    return (
      <ConfigEditorQueryError
        offline={isUnreachableError(currentQuery.error)}
        retrying={currentQuery.isRefetching}
        onRetry={() => currentQuery.refetch()}
      />
    );
  }

  const current = currentQuery.data;
  if (!current) {
    return <ConfigEditorSkeleton />;
  }

  if (current.parseError) {
    return <ConfigEditorEmptyState variant="parseError" />;
  }

  return <ConfigEditorForm metadata={metadataQuery.data} maskedContent={current.maskedContent} />;
}

function ConfigEditorForm({
  metadata,
  maskedContent,
}: {
  metadata: ConfigMetadata;
  maskedContent: string;
}) {
  const t = useTranslations("configEditor");
  const form = useConfigForm(metadata, maskedContent);
  const categories = metadata.categories;
  const defaultTab = categories[0]?.id ?? "basic";

  return (
    <Tabs defaultValue={defaultTab} className="w-full">
      <TabsList className="glass h-auto flex-wrap justify-start gap-1 p-1">
        {categories.map((category) => {
          const Icon = CATEGORY_ICONS[category.id] ?? Settings2;
          return (
            <TabsTrigger key={category.id} value={category.id} className="gap-1.5">
              <Icon className="w-3.5 h-3.5" />
              {t(`categories.${category.id}`)}
            </TabsTrigger>
          );
        })}
      </TabsList>

      {categories.map((category) => (
        <TabsContent key={category.id} value={category.id} className="overflow-hidden">
          {category.isTable ? (
            <ConfigTableEditor category={category} form={form} />
          ) : (
            <FlatCategoryForm category={category} form={form} />
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function FlatCategoryForm({
  category,
  form,
}: {
  category: FlatCategory;
  form: UseConfigFormResult;
}) {
  const categoryValues = form.values[category.id] ?? {};

  return (
    <Card>
      <CardContent className="p-5 divide-y divide-border/60">
        {category.fields.map((field) => (
          <FieldRenderer
            key={field.key}
            field={field}
            value={categoryValues[field.key]}
            path={field.key}
            siblingValues={categoryValues}
            dirty={form.isFieldDirty(category.id, field.key)}
            onChange={(value) => form.setFieldValue(category.id, field.key, value)}
            onReset={() => form.resetField(category.id, field.key)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function ConfigEditorSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-1.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-8 w-24 rounded-md bg-muted/50 animate-pulse" />
        ))}
      </div>
      <div className="rounded-xl border bg-card p-5 space-y-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center justify-between gap-3">
            <div className="space-y-1.5">
              <div className="h-4 w-32 rounded bg-muted/60 animate-pulse" />
              <div className="h-3 w-48 rounded bg-muted/40 animate-pulse" />
            </div>
            <div className="h-9 w-48 rounded-md bg-muted/40 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfigEditorLoadError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("configEditor");
  return (
    <div
      role="alert"
      className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex flex-wrap items-center justify-between gap-3"
    >
      <div className="flex items-center gap-3">
        <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
        <p className="text-sm font-medium text-destructive">{t("loadError")}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
        <RefreshCw className="w-3.5 h-3.5" />
        {t("retry")}
      </Button>
    </div>
  );
}

function ConfigEditorQueryError({
  offline,
  retrying,
  onRetry,
}: {
  offline: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations("configEditor");
  return (
    <div className="flex items-center justify-center min-h-[50vh] p-4">
      <div
        role="alert"
        className={cn(
          "rounded-xl border p-4 flex flex-wrap items-center justify-between gap-3 max-w-md w-full",
          offline ? "border-amber-500/30 bg-amber-500/5" : "border-destructive/30 bg-destructive/5",
        )}
      >
        <div className="flex items-center gap-3">
          <AlertTriangle
            className={cn(
              "w-5 h-5 shrink-0",
              offline ? "text-amber-600 dark:text-amber-400" : "text-destructive",
            )}
          />
          <p className={cn("text-sm", offline ? "text-amber-700 dark:text-amber-300" : "text-destructive")}>
            {offline ? t("offlineBanner") : t("loadError")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying} className="gap-1.5">
          <RefreshCw className={cn("w-3.5 h-3.5", retrying && "animate-spin")} />
          {t("retry")}
        </Button>
      </div>
    </div>
  );
}

function ConfigEditorEmptyState({ variant }: { variant: "noConfig" | "parseError" }) {
  const t = useTranslations("configEditor.emptyState");
  const Icon = variant === "noConfig" ? FileWarning : AlertTriangle;
  return (
    <div className="flex items-center justify-center min-h-[50vh] p-4">
      <div className="text-center max-w-md space-y-2">
        <Icon className="w-10 h-10 mx-auto text-muted-foreground" />
        <h3 className="text-base font-semibold">{t(`${variant}.title`)}</h3>
        <p className="text-sm text-muted-foreground">{t(`${variant}.description`)}</p>
      </div>
    </div>
  );
}
