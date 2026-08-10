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
 *
 * M2b Task 10: `ConfigEditorForm` now also owns the "应用" bar (dirty
 * count + button) and `ApplyDialog` (apply-dialog.tsx — YAML preview,
 * pre-apply diff, apply, and conflict resolution). The actual submitted
 * text is built by `use-submit-content.ts`'s `buildSubmittedText` — a CST
 * patch of ONLY the dirty leaf paths onto `maskedContent`, never
 * `yaml.stringify(form.document)` (see that file's header for the full
 * I4 rationale). `ConfigEditorForm` itself only owns the conflict-replay
 * plumbing (`pendingReplay`, `handleRefetchAndReplay`, `handleDiscard`) —
 * it must live here rather than inside `ApplyDialog` because replaying
 * requires calling back into `useConfigForm`'s own `setFieldValue`/
 * `resetField`, which only this component holds.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { apiErrorCode, isUnreachableError, type ConfigCurrent } from "@/lib/api";
import { useConfigCurrent } from "@/hooks/api/use-config-editor";
import { FieldRenderer } from "./field-renderer";
import { ConfigTableEditor } from "./config-table-editor";
import { ApplyDialog } from "./apply-dialog";
import {
  useConfigForm,
  getAtPath,
  parseDocument as parseMaskedContentToValue,
  type DirtyEntry,
  type UseConfigFormResult,
} from "./use-config-form";
import type { ConfigMetadata, FlatCategory } from "@/lib/types/config-metadata";

/** Structural deep-equality over plain YAML-parsed values (string/number/
 *  boolean/null/undefined/array/object) — used ONLY by the conflict-replay
 *  staleness check below (Finding 2), to tell whether upstream ALSO
 *  touched a given path since the user started editing. Deliberately not
 *  imported from anywhere: apply-pipeline.ts (apps/collector) has an
 *  equivalent, but it's a different package; use-config-form.ts has no
 *  equivalent of its own to reuse. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aRec = a as Record<string, unknown>;
    const bRec = b as Record<string, unknown>;
    const aKeys = Object.keys(aRec);
    const bKeys = Object.keys(bRec);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bRec, k) && deepEqual(aRec[k], bRec[k]));
  }
  return false;
}

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

  return (
    <ConfigEditorForm
      metadata={metadataQuery.data}
      current={current}
      // Safe: `current` is only reachable once `useConfigCurrent` succeeded,
      // and that query is `enabled: backendId !== undefined` (Task 7) — so
      // `current` being defined implies `backendId` was too.
      backendId={backendId as number}
      onRefetchCurrent={() => currentQuery.refetch()}
    />
  );
}

function ConfigEditorForm({
  metadata,
  current,
  backendId,
  onRefetchCurrent,
}: {
  metadata: ConfigMetadata;
  current: ConfigCurrent;
  backendId: number;
  onRefetchCurrent: () => Promise<{ data?: ConfigCurrent }>;
}) {
  const t = useTranslations("configEditor");
  const form = useConfigForm(metadata, current.maskedContent);
  const categories = metadata.categories;
  const defaultTab = categories[0]?.id ?? "basic";

  const [applyOpen, setApplyOpen] = useState(false);
  // Conflict-replay plumbing ("拉取最新并重放我的修改", task-10-brief.md):
  // `useConfigForm` resets its OWN `document`/`dirty` state atomically the
  // instant its `maskedContent` argument's IDENTITY changes (see that
  // file's header comment) — during RENDER, strictly before any effect
  // could run. The replay below piggybacks on that same "adjusting state
  // during render" discipline (React's own sanctioned pattern; see
  // use-config-form.ts's header comment) instead of a `useEffect` — partly
  // because an effect-based version of this trips this repo's
  // `react-hooks/set-state-in-effect` lint rule, but more fundamentally
  // because it's the exact same category of derived-state adjustment
  // use-config-form.ts already performs internally: detected during THIS
  // render (`pendingReplay.forContent === current.maskedContent`), applied
  // via `form.setFieldValue`/`setPendingReplay` calls in THIS render, which
  // is safe because `form` is `useConfigForm(...)`'s result called
  // directly in THIS component's own render body — its `setState` belongs
  // to this exact Fiber, same as `use-config-form.ts`'s own internal reset.
  // The gate (`forContent === current.maskedContent`) guarantees
  // `useConfigForm`'s reset has ALREADY landed by the time the replay runs,
  // regardless of how `current.maskedContent` got here (a React Query
  // refetch, batched or not) — a byte-identical refetch (disk didn't
  // actually change further) makes the gate pass on the very first render
  // with no reset having been needed at all, still correct, since replaying
  // onto an already-correct base is a no-op-equivalent set of
  // `setFieldValue` calls. Calling `setPendingReplay(null)` in the SAME
  // pass is what makes this converge in one extra render instead of
  // looping: the guard is false on the next pass, so nothing repeats.
  const [pendingReplay, setPendingReplay] = useState<{
    forContent: string;
    entries: DirtyEntry[];
  } | null>(null);

  if (pendingReplay && pendingReplay.forContent === current.maskedContent) {
    for (const entry of pendingReplay.entries) {
      form.setFieldValue(entry.categoryId, entry.fieldKey, entry.value);
    }
    setPendingReplay(null);
  }

  // Not memoized: `getDirtyEntries()` just enumerates the (small) in-memory
  // dirty set, cheap enough to recompute every render — and doing so avoids
  // an exhaustive-deps false positive (`form` itself is a fresh object
  // every render, only `form.getDirtyEntries`'s IDENTITY tracks the actual
  // dirty state per use-config-form.ts's own doc comment).
  const dirtyEntries = form.getDirtyEntries();

  // (Finding 2, review fix) Human-readable identifier for a skipped-entry
  // toast — the translated category name, plus the raw dotted field key
  // when it names something MORE specific than the category itself (a
  // table category's one dirty entry has `fieldKey === categoryId`, so
  // showing both would just repeat the same word twice).
  const describeEntry = (entry: DirtyEntry) => {
    const category = t(`categories.${entry.categoryId}`);
    return entry.fieldKey === entry.categoryId ? category : `${category} · ${entry.fieldKey}`;
  };

  const handleRefetchAndReplay = async () => {
    // Captured BEFORE refetching — refetching alone (via the prop change it
    // causes) resets `form`'s dirty set to empty, by design (see
    // use-config-form.ts's header comment on why a stale dirty set must not
    // survive a legitimate new base). `baseValue` on each entry is what was
    // on disk BEFORE this edit started — see use-config-form.ts's doc
    // comment on `DirtyEntry.baseValue` for why that, not `value`, is what
    // gets compared against the fresh fetch below.
    const entries = form.getDirtyEntries();
    const result = await onRefetchCurrent();
    if (!result.data || result.data.parseError) {
      toast.error(t("conflict.refetchFailed"));
      return;
    }

    // (Finding 2, review fix) Blindly replaying every captured entry onto
    // the freshly-fetched base is a silent merge by another name: if
    // upstream ALSO changed a path the user edited (e.g. deleted a row the
    // user was editing), replaying the user's stale edit on top would
    // silently resurrect/overwrite whatever the other change did, with no
    // review step — exactly the "no silent merge" rule this conflict flow
    // exists to enforce, just approached from the other direction. So each
    // entry is only replayed when the FRESH base's value at that path
    // still matches what it was when the user started editing
    // (`entry.baseValue`) — i.e. nobody else touched that exact path.
    // Otherwise the entry is skipped (the fresh value wins, unmodified)
    // and the user is told, per-entry, so they can go re-apply their
    // intent deliberately against the new reality instead of it happening
    // for them.
    const freshValue = parseMaskedContentToValue(result.data.maskedContent);
    const toReplay: DirtyEntry[] = [];
    const skipped: DirtyEntry[] = [];
    for (const entry of entries) {
      if (deepEqual(getAtPath(freshValue, entry.path), entry.baseValue)) {
        toReplay.push(entry);
      } else {
        skipped.push(entry);
      }
    }

    if (toReplay.length > 0) {
      setPendingReplay({ forContent: result.data.maskedContent, entries: toReplay });
      toast.success(t("conflict.replayed"));
    }
    for (const entry of skipped) {
      toast.error(t("conflict.entrySkipped", { field: describeEntry(entry) }));
    }
  };

  const handleDiscard = () => {
    for (const entry of form.getDirtyEntries()) {
      form.resetField(entry.categoryId, entry.fieldKey);
    }
    toast.success(t("conflict.discarded"));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap rounded-xl border bg-card px-4 py-3">
        <span className="text-sm text-muted-foreground">
          {form.hasAnyDirty ? t("apply.dirtyCount", { count: dirtyEntries.length }) : t("apply.noChanges")}
        </span>
        <Button size="sm" disabled={!form.hasAnyDirty} onClick={() => setApplyOpen(true)} className="gap-1.5">
          {t("apply.button")}
        </Button>
      </div>

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

      {/* (Finding 3, review fix) Mounted ONLY while open — matches
          config-table-editor.tsx's `ObjectRowEditDialog`/`RuleEditDialog`
          precedent (`{editing && (<... open .../>)}`) and is what makes
          ApplyDialog's own lazy-`useState` `submittedText` computation
          correct: closed means unmounted means zero cost, and the NEXT
          open is always a fresh mount with a fresh computation. */}
      {applyOpen && (
        <ApplyDialog
          open
          onOpenChange={(next) => !next && setApplyOpen(false)}
          backendId={backendId}
          maskedContent={current.maskedContent}
          baseHash={current.hash}
          dirtyEntries={dirtyEntries}
          onRefetchAndReplay={handleRefetchAndReplay}
          onDiscard={handleDiscard}
        />
      )}
    </div>
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
