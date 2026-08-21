"use client";

/**
 * M2b Task 11 — saved config version list + rollback.
 *
 * Self-contained: owns `useConfigVersions` (list) and `useRollbackConfig`
 * (action). Rollback goes through the SAME command pipeline as a normal
 * apply — config-editor.controller.ts's `/rollback/:versionId` handler
 * enqueues a command exactly like `/apply` does — so `useRollbackConfig`'s
 * existing `configLatestCommandQueryKey` invalidation (Task 7) is what
 * makes the resulting command show up in `CommandTimeline`; this component
 * does not track the command itself, only fires the mutation.
 *
 * "Current version" is determined by comparing `versionId` against
 * `currentVersionId` (from `ConfigCurrent.versionId`, threaded down from
 * config-editor-page.tsx) rather than assuming array order/index 0 — more
 * robust even though `listMeta`'s `ORDER BY id DESC`
 * (config-version.repository.ts) does happen to put it first today.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp, History, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatBytes, formatTimestamp } from "@/lib/utils";
import { useConfigVersions, useRollbackConfig } from "@/hooks/api/use-config-editor";
import type { ConfigVersionMeta } from "@/lib/api";

interface VersionHistoryProps {
  backendId: number;
  currentVersionId: number;
  /** True when the user has in-progress, unsaved edits — rolling back
   *  invalidates `configCurrentQueryKey`, which resets `useConfigForm`'s
   *  working document (see use-config-form.ts's header: a new
   *  `maskedContent` identity always wins over a stale dirty set) — so a
   *  rollback silently discards those edits with no other warning. Task 10
   *  documented an equivalent loss for a successful APPLY as pre-existing
   *  and acceptable (the apply itself consumed the edits); rollback has no
   *  such excuse — it's an unrelated action a dirty user can trigger by
   *  mistake — so the confirm dialog surfaces it explicitly here. */
  hasAnyDirty: boolean;
}

export function VersionHistory({ backendId, currentVersionId, hasAnyDirty }: VersionHistoryProps) {
  const t = useTranslations("configEditor.history");
  const versionsQuery = useConfigVersions(backendId);
  const rollbackMutation = useRollbackConfig(backendId);
  const [open, setOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<ConfigVersionMeta | null>(null);

  const versions = versionsQuery.data?.versions ?? [];

  const handleConfirm = () => {
    if (!confirmTarget) return;
    rollbackMutation.mutate(confirmTarget.versionId, {
      onSuccess: () => setConfirmTarget(null),
    });
  };

  return (
    <div className="rounded-xl border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <History className="w-4 h-4 text-muted-foreground" />
          {t("title")}
          {versions.length > 0 && <Badge variant="secondary">{versions.length}</Badge>}
        </span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {open && (
        <div className="border-t px-4 py-3">
          {versionsQuery.isLoading ? (
            <p className="text-xs text-muted-foreground py-4 text-center">{t("loading")}</p>
          ) : versions.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">{t("empty")}</p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.createdAt")}</TableHead>
                    <TableHead>{t("columns.source")}</TableHead>
                    <TableHead>{t("columns.size")}</TableHead>
                    <TableHead>{t("columns.hash")}</TableHead>
                    <TableHead className="text-right">{t("columns.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((version) => {
                    const isCurrent = version.versionId === currentVersionId;
                    return (
                      <TableRow key={version.versionId}>
                        <TableCell className="whitespace-nowrap">{formatTimestamp(version.createdAt)}</TableCell>
                        <TableCell>{version.source}</TableCell>
                        <TableCell>{formatBytes(version.size)}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {version.hash.slice(0, 12)}
                        </TableCell>
                        <TableCell className="text-right">
                          {isCurrent ? (
                            <Badge variant="outline">{t("current")}</Badge>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmTarget(version)}
                              className="gap-1.5"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              {t("rollback")}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(next) => {
          if (!next && rollbackMutation.isPending) return;
          if (!next) setConfirmTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {confirmTarget &&
                    t("confirmDescription", {
                      time: formatTimestamp(confirmTarget.createdAt),
                      source: confirmTarget.source,
                    })}
                </p>
                {hasAnyDirty && (
                  <p className="text-amber-600 dark:text-amber-400">{t("confirmDirtyWarning")}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rollbackMutation.isPending}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleConfirm();
              }}
              disabled={rollbackMutation.isPending}
              className="gap-1.5"
            >
              {rollbackMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t("confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
