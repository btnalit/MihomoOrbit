"use client";

/**
 * M2b Task 10 — pre-apply diff: `diff` package's `diffLines(before, after)`
 * rendered as an equal-width, per-line +green/−red view.
 *
 * BINDING (M2a→M2b handoff, "Task 8: 强约束→Task 10", point ②): this view
 * must clearly surface field DELETIONS — a masked field typed-into-then-
 * cleared stages a deletion (see field-renderer.tsx's masked-control
 * "replace wholesale" flow + use-config-form.ts's delete-on-`undefined`
 * convention), and the diff is the designed catch for it before it ever
 * reaches the server. A deletion always shows up as one or more REMOVED
 * lines here (the key's whole `key: value` line vanishes), so on top of the
 * per-line red styling, this component adds a summary count and an
 * explicit callout whenever any line was removed — a user skimming past a
 * wall of green additions shouldn't be able to miss that something also
 * disappeared.
 */

import { diffLines } from "diff";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface DiffLine {
  key: number;
  text: string;
  kind: "added" | "removed" | "context";
}

/** `diffLines`'s `part.value` is one or more COMPLETE lines joined by `\n`,
 *  with a trailing `\n` for every chunk except possibly the very last one —
 *  splitting naively would render a phantom empty trailing row per chunk,
 *  so the final empty segment (when present) is dropped. */
function toLines(parts: ReturnType<typeof diffLines>): DiffLine[] {
  const lines: DiffLine[] = [];
  let key = 0;
  for (const part of parts) {
    const kind: DiffLine["kind"] = part.added ? "added" : part.removed ? "removed" : "context";
    const rows = part.value.split("\n");
    if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    for (const row of rows) {
      lines.push({ key: key++, text: row, kind });
    }
  }
  return lines;
}

interface ConfigDiffViewProps {
  before: string;
  after: string;
}

export function ConfigDiffView({ before, after }: ConfigDiffViewProps) {
  const t = useTranslations("configEditor.apply");
  const parts = diffLines(before, after);

  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.added) added += part.count ?? 0;
    if (part.removed) removed += part.count ?? 0;
  }
  const hasChanges = added > 0 || removed > 0;
  const lines = toLines(parts);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="font-mono font-medium text-emerald-700 dark:text-emerald-400">
          +{added}
        </span>
        <span className="font-mono font-medium text-red-700 dark:text-red-400">-{removed}</span>
        {!hasChanges && <span className="text-muted-foreground">{t("diffUnchanged")}</span>}
      </div>

      {removed > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{t("diffHasDeletions")}</span>
        </div>
      )}

      <div className="rounded-md border overflow-hidden">
        <ScrollArea className="max-h-96">
          <div className="font-mono text-xs leading-5">
            {lines.map((line) => (
              <div
                key={line.key}
                className={cn(
                  "px-3 whitespace-pre-wrap break-all",
                  line.kind === "added" &&
                    "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
                  line.kind === "removed" && "bg-red-500/10 text-red-800 dark:text-red-300",
                )}
              >
                <span className="select-none opacity-60 mr-2">
                  {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
                </span>
                {line.text.length > 0 ? line.text : " "}
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
