"use client";

/**
 * M2b Task 10 — apply flow: YAML preview + pre-apply diff + confirm, with
 * conflict UX for a stale base hash and a dedicated explanation for a
 * renamed-masked-row rejection.
 *
 * Submitted content (binding, see use-submit-content.ts's header for the
 * full contract): `buildSubmittedText(maskedContent, dirtyEntries)` —
 * NEVER `yaml.stringify(form.document)`. Wrapped in try/catch: a rare but
 * real edge case (deleting a field that holds a YAML anchor referenced
 * elsewhere in the SAME config) makes the patcher throw — caught here and
 * shown as a friendly, localized error instead of crashing the tab.
 *
 * Mount-gated by the parent (M2b Task 10 review fix, Finding 3):
 * config-editor-page.tsx only renders `<ApplyDialog .../>` while
 * `applyOpen` is true (`{applyOpen && <ApplyDialog open .../>}`, same
 * pattern config-table-editor.tsx's `ObjectRowEditDialog`/`RuleEditDialog`
 * already use) — closed means this component isn't mounted at all, zero
 * cost. That in turn is what makes computing `submittedText` via a LAZY
 * `useState` initializer (below) correct: it runs exactly ONCE, at mount
 * (= dialog-open) time, and never again for the lifetime of this mount —
 * no `useMemo` reactively re-deriving it off `dirtyEntries` (a fresh array
 * every parent render, which defeated a memo dependency check on every
 * render while this component stayed permanently mounted; measured
 * 64ms/keystroke on a 60KB config before this fix). `view`/`maskPathMissing`
 * follow the same logic — plain `useState`, no reset-on-open effect or
 * render-phase adjustment needed, since a fresh mount already starts fresh.
 *
 * Error-code UX (binding, task-10-brief.md):
 * - `BASE_HASH_STALE` (apply's own 409, this task's primary conflict
 *   trigger): switches this dialog to a "磁盘配置已变更" conflict card with
 *   two actions — refetch-and-replay (calls the parent-owned
 *   `onRefetchAndReplay`, then closes so the user re-opens "应用" against
 *   the now-current base) and discard (calls the parent-owned `onDiscard`,
 *   then closes). No silent merge either way (盘 §5.5).
 * - `MASK_PATH_MISSING` (a renamed row whose masked field couldn't resolve
 *   — Task 9's identity-aware sentinel contract, apply-pipeline.ts's
 *   `collectAndSubstitute` array branch): shown as an inline explanation
 *   ABOVE the diff (dialog stays open, still showing the diff/preview for
 *   context) rather than a generic toast alone, since "reveal/re-enter that
 *   field" is actionable guidance the generic error mapping doesn't carry.
 * - Every other code (`YAML_INVALID`, `SELF_LOCK_FIELD_CHANGED`,
 *   `CONFIG_COMMAND_IN_FLIGHT`, etc.): `useApplyConfig`'s own `onError`
 *   (use-config-editor.ts, Task 7) fires the mapped toast — this dialog
 *   does nothing further for those. `BASE_HASH_STALE`/`MASK_PATH_MISSING`
 *   are passed as `silentCodes` (M2b Task 10 review fix, Finding 1) so
 *   that hook-level toast does NOT also fire for the two codes this
 *   dialog owns dedicated UI for — TanStack Query v5 calls BOTH the
 *   hook-level `onError` and this per-`mutate()`-call `onError` on every
 *   failure, so without `silentCodes` the generic toast and this dialog's
 *   conflict card / inline explanation would appear at the same instant,
 *   both describing the same failure.
 *
 * On success: `useApplyConfig`'s own `onSuccess` already invalidates
 * current/versions/latestCommand (Task 7) — this dialog only adds a
 * "submitted" toast and closes itself. Command-tracking (polling
 * `useLatestCommand` to a terminal state) is explicitly Task 11's scope;
 * this is the clean wiring point Task 11 hooks into.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { apiErrorCode } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { useApplyConfig } from "@/hooks/api/use-config-editor";
import { buildSubmittedText } from "./use-submit-content";
import { ConfigDiffView } from "./config-diff-view";
import type { DirtyEntry } from "./use-config-form";

/** Codes this dialog owns dedicated UI for — see Finding 1 in the file
 *  header. Module-level constant so it's the SAME array reference every
 *  render (not that `useApplyConfig` depends on referential stability
 *  today, but there's no reason to allocate a new literal every render
 *  either). */
const SILENT_ERROR_CODES = ["BASE_HASH_STALE", "MASK_PATH_MISSING"];

function maskPathFromError(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  const data = error.data as { path?: unknown } | undefined;
  return typeof data?.path === "string" ? data.path : undefined;
}

interface ApplyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  backendId: number;
  /** The current on-disk (masked) content — the diff/patch BASE. */
  maskedContent: string;
  baseHash: string;
  dirtyEntries: DirtyEntry[];
  /** Conflict action 1: refetch the latest current config and replay these
   *  same dirty entries onto it (owned by the parent — see
   *  config-editor-page.tsx — because it must coordinate with
   *  `useConfigForm`'s own state, not just this dialog's). */
  onRefetchAndReplay: () => Promise<void>;
  /** Conflict action 2: discard all in-progress edits, restoring every
   *  dirty field to its original value. */
  onDiscard: () => void;
}

export function ApplyDialog({
  open,
  onOpenChange,
  backendId,
  maskedContent,
  baseHash,
  dirtyEntries,
  onRefetchAndReplay,
  onDiscard,
}: ApplyDialogProps) {
  const t = useTranslations("configEditor.apply");
  const tConflict = useTranslations("configEditor.conflict");
  const applyMutation = useApplyConfig(backendId, { silentCodes: SILENT_ERROR_CODES });

  // Plain `useState` — no reset-on-open logic needed. The parent only
  // mounts this component while `applyOpen` is true (see the file header),
  // so a fresh mount already means fresh state; there is no "previous
  // attempt's leftover view" to guard against within a single mount.
  const [view, setView] = useState<"preview" | "conflict">("preview");
  const [maskPathMissing, setMaskPathMissing] = useState<string | undefined>(undefined);
  const [replaying, setReplaying] = useState(false);

  // Computed ONCE, at mount (= dialog-open) time, via a lazy `useState`
  // initializer — NOT a `useMemo` reactively keyed on `dirtyEntries`/
  // `maskedContent` (see Finding 3 in the file header for why that was
  // measurably expensive). Any prop changes for the remainder of this
  // mount's lifetime are intentionally ignored: the diff/preview the user
  // is reviewing must stay stable while they're looking at it, and the
  // only two ways this dialog is supposed to see fresher data — a
  // successful apply, or the conflict card's refetch-and-replay — both
  // close this dialog first, so the NEXT open gets a fresh mount and
  // therefore a fresh computation for free.
  const [submittedResult] = useState(() => {
    try {
      return { ok: true as const, text: buildSubmittedText(maskedContent, dirtyEntries) };
    } catch (err) {
      // Rare (see use-submit-content.ts's header: deleting a field that
      // holds a YAML anchor referenced elsewhere in the same config) but
      // real — logged for diagnosability. The user only ever sees the
      // localized `submitContentError` copy below, never this raw message.
      console.error("buildSubmittedText failed", err);
      return { ok: false as const };
    }
  });

  const handleOpenChange = (next: boolean) => {
    // Ignore close attempts (Escape / overlay click / X) while a request is
    // in flight — losing the dialog mid-mutation would strand the user
    // without a way to see the outcome.
    if (!next && applyMutation.isPending) return;
    onOpenChange(next);
  };

  const handleConfirm = () => {
    if (!submittedResult.ok) return;
    setMaskPathMissing(undefined);
    applyMutation.mutate(
      { content: submittedResult.text, baseHash },
      {
        onSuccess: () => {
          toast.success(t("submitted"));
          onOpenChange(false);
        },
        onError: (error) => {
          const code = apiErrorCode(error);
          if (code === "BASE_HASH_STALE") {
            setView("conflict");
            return;
          }
          if (code === "MASK_PATH_MISSING") {
            setMaskPathMissing(maskPathFromError(error) ?? "");
          }
          // Every other code: use-config-editor.ts's onError already toasted
          // the mapped message (Task 7) — nothing further to do here.
        },
      },
    );
  };

  const handleRefetchAndReplay = async () => {
    setReplaying(true);
    try {
      await onRefetchAndReplay();
      onOpenChange(false);
    } finally {
      setReplaying(false);
    }
  };

  const handleDiscard = () => {
    onDiscard();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {view === "conflict" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                {tConflict("title")}
              </DialogTitle>
              <DialogDescription>{tConflict("description")}</DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col sm:flex-row sm:justify-end gap-2">
              <Button variant="outline" onClick={handleDiscard} disabled={replaying}>
                {tConflict("discard")}
              </Button>
              <Button onClick={handleRefetchAndReplay} disabled={replaying} className="gap-1.5">
                {replaying && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {tConflict("refetchAndReplay")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("dialogTitle")}</DialogTitle>
              <DialogDescription>{t("dialogDescription")}</DialogDescription>
            </DialogHeader>

            {maskPathMissing !== undefined && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive space-y-1"
              >
                <p className="font-medium">{t("maskPathMissingTitle")}</p>
                <p>{t("maskPathMissingDescription")}</p>
                {maskPathMissing && <p className="font-mono">{t("maskPathMissingField", { path: maskPathMissing })}</p>}
              </div>
            )}

            {!submittedResult.ok ? (
              <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                {t("submitContentError")}
              </div>
            ) : (
              <Tabs defaultValue="diff" className="w-full">
                <TabsList className="glass">
                  <TabsTrigger value="diff">{t("tabDiff")}</TabsTrigger>
                  <TabsTrigger value="preview">{t("tabPreview")}</TabsTrigger>
                </TabsList>
                <TabsContent value="diff">
                  <ConfigDiffView before={maskedContent} after={submittedResult.text} />
                </TabsContent>
                <TabsContent value="preview">
                  <div className="rounded-md border overflow-hidden">
                    <ScrollArea className="max-h-96">
                      <pre className="font-mono text-xs leading-5 p-3 whitespace-pre-wrap break-all">
                        {submittedResult.text}
                      </pre>
                    </ScrollArea>
                  </div>
                </TabsContent>
              </Tabs>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applyMutation.isPending}>
                {t("cancel")}
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={!submittedResult.ok || applyMutation.isPending || dirtyEntries.length === 0}
                className="gap-1.5"
              >
                {applyMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {applyMutation.isPending ? t("confirming") : t("confirm")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
