"use client";

/**
 * M2b Task 11 — command status timeline: pending → dispatched →
 * applied/conflict/rolled-back/failed, with an expired hint and a terminal
 * `reason` display.
 *
 * Self-contained: owns its own `useLatestCommand(backendId, { poll: true })`
 * — use-config-editor.ts derives the actual refetch FREQUENCY from the
 * fetched command's own `state`/`expired` (a `refetchInterval` function, see
 * that hook's doc comment), so this component only has to ask to poll; the
 * hook stops itself once the latest command is null/terminal/expired. No
 * component-level polling state machine lives here.
 *
 * Renders nothing while there's no latest command at all (`command ===
 * null`, or the query hasn't resolved yet) — `useApplyConfig`/
 * `useRollbackConfig` already invalidate this exact query on every
 * apply/rollback (Task 7), so a fresh command shows up here within one
 * refetch of either action succeeding, with no extra wiring needed here.
 *
 * Default expanded/collapsed follows the command's own urgency (in-progress
 * or awaiting a conflict decision → expanded; already resolved →
 * collapsed-but-visible) UNLESS the user has manually toggled it — see
 * `manualOpen`'s doc comment below.
 *
 * Conflict actions ("拉取最新并重放我的修改"/"放弃我的修改") are NOT
 * reimplemented here — `onRefetchAndReplay`/`onDiscard` are the SAME
 * handlers `ApplyDialog`'s conflict card already calls, owned by
 * `ConfigEditorForm` in config-editor-page.tsx (they must coordinate with
 * `useConfigForm`'s own `setFieldValue`/`resetField`, which only that
 * component holds — see its file header for the full rationale). This
 * component is just a second caller of the exact same two callbacks.
 *
 * `COMMAND_TIMELINE_ELEMENT_ID` is exported for apply-dialog.tsx's
 * `CONFIG_COMMAND_IN_FLIGHT` affordance ("查看进行中的应用") to scroll/focus
 * this element by a plain DOM id — deliberately not a ref/context, since
 * `ApplyDialog` and `CommandTimeline` are unrelated siblings under
 * `ConfigEditorForm` and a shared id is the smallest coupling that works
 * for a "scroll to this other component" cross-cut.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Loader2,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatTimestamp } from "@/lib/utils";
import { useLatestCommand } from "@/hooks/api/use-config-editor";
import type { ConfigCommandState, ConfigCommandStatus } from "@/lib/api";

export const COMMAND_TIMELINE_ELEMENT_ID = "config-command-timeline";

const IN_PROGRESS_STATES = new Set<ConfigCommandState>(["pending", "dispatched"]);
const TERMINAL_STATES = new Set<ConfigCommandState>([
  "applied",
  "conflict",
  "rolled-back",
  "failed",
]);

function stepIndex(state: ConfigCommandState): 0 | 1 | 2 {
  if (state === "pending") return 0;
  if (state === "dispatched") return 1;
  return 2;
}

type Translator = ReturnType<typeof useTranslations>;

function stateLabel(state: ConfigCommandState, t: Translator): string {
  switch (state) {
    case "pending":
      return t("statePending");
    case "dispatched":
      return t("stateDispatched");
    case "applied":
      return t("stateApplied");
    case "conflict":
      return t("stateConflict");
    case "rolled-back":
      return t("stateRolledBack");
    case "failed":
      return t("stateFailed");
  }
}

/** Icon + tone for the 3rd step ("outcome") once it's actually reached —
 *  unused while the command is still pending/dispatched (that step shows a
 *  neutral placeholder dot instead). */
function terminalVisual(state: ConfigCommandState) {
  switch (state) {
    case "applied":
      return { icon: CheckCircle2, tone: "text-emerald-600 dark:text-emerald-400 border-emerald-500 bg-emerald-500/10" };
    case "conflict":
      return { icon: AlertTriangle, tone: "text-amber-600 dark:text-amber-400 border-amber-500 bg-amber-500/10" };
    case "rolled-back":
      return { icon: RotateCcw, tone: "text-blue-600 dark:text-blue-400 border-blue-500 bg-blue-500/10" };
    case "failed":
      return { icon: XCircle, tone: "text-red-600 dark:text-red-400 border-red-500 bg-red-500/10" };
    default:
      return { icon: Circle, tone: "text-muted-foreground border-border" };
  }
}

function StepDot({
  icon: Icon,
  tone,
  spinning,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  spinning?: boolean;
}) {
  return (
    <div className={cn("flex items-center justify-center w-7 h-7 rounded-full border-2 shrink-0", tone)}>
      <Icon className={cn("w-3.5 h-3.5", spinning && "animate-spin")} />
    </div>
  );
}

function CommandSteps({ command, t }: { command: ConfigCommandStatus; t: Translator }) {
  const idx = stepIndex(command.state);
  const terminal = idx === 2 ? terminalVisual(command.state) : null;

  const nodes: { label: string; icon: React.ComponentType<{ className?: string }>; tone: string; spinning?: boolean; reached: boolean }[] = [
    {
      label: t("stepPending"),
      icon: idx === 0 ? Loader2 : CheckCircle2,
      tone:
        idx === 0
          ? "text-primary border-primary bg-primary/10"
          : "text-emerald-600 dark:text-emerald-400 border-emerald-500 bg-emerald-500/10",
      spinning: idx === 0,
      reached: true,
    },
    {
      label: t("stepDispatched"),
      icon: idx === 1 ? Loader2 : idx > 1 ? CheckCircle2 : Circle,
      tone:
        idx === 1
          ? "text-primary border-primary bg-primary/10"
          : idx > 1
            ? "text-emerald-600 dark:text-emerald-400 border-emerald-500 bg-emerald-500/10"
            : "text-muted-foreground border-border",
      spinning: idx === 1,
      reached: idx >= 1,
    },
    {
      label: idx === 2 ? stateLabel(command.state, t) : t("stepOutcome"),
      icon: terminal?.icon ?? Circle,
      tone: terminal?.tone ?? "text-muted-foreground border-border",
      reached: idx === 2,
    },
  ];

  return (
    <div className="flex items-start">
      {nodes.map((node, i) => (
        <div key={i} className={cn("flex items-center", i < nodes.length - 1 && "flex-1")}>
          <div className="flex flex-col items-center gap-1">
            <StepDot icon={node.icon} tone={node.tone} spinning={node.spinning} />
            <span className="text-[11px] text-muted-foreground whitespace-nowrap">{node.label}</span>
          </div>
          {i < nodes.length - 1 && (
            <div
              className={cn(
                "h-0.5 flex-1 mx-1 mb-4 rounded-full",
                nodes[i + 1].reached ? "bg-emerald-500/60" : "bg-border",
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}

interface CommandTimelineProps {
  backendId: number | undefined;
  onRefetchAndReplay: () => Promise<void>;
  onDiscard: () => void;
}

export function CommandTimeline({ backendId, onRefetchAndReplay, onDiscard }: CommandTimelineProps) {
  const t = useTranslations("configEditor.timeline");
  const tConflict = useTranslations("configEditor.conflict");
  const query = useLatestCommand(backendId, { poll: true });

  // `undefined` = the user hasn't manually toggled this session; the
  // effective open/collapsed state below then follows the command's own
  // urgency instead, so e.g. a fresh in-progress command (including the one
  // that just appeared after a CONFIG_COMMAND_IN_FLIGHT scroll-to, see the
  // file header) auto-expands without any extra coordination. Once the user
  // clicks the toggle, their choice wins regardless of state changes.
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined);
  const [replaying, setReplaying] = useState(false);

  const command = query.data?.command ?? null;
  if (!command) return null;

  const defaultOpen = IN_PROGRESS_STATES.has(command.state) || command.state === "conflict";
  const open = manualOpen ?? defaultOpen;
  const showExpiredHint = IN_PROGRESS_STATES.has(command.state) && command.expired;
  const showReason = TERMINAL_STATES.has(command.state) && command.reason.trim().length > 0;
  const isConflict = command.state === "conflict";

  const handleRefetchAndReplay = async () => {
    setReplaying(true);
    try {
      await onRefetchAndReplay();
    } finally {
      setReplaying(false);
    }
  };

  return (
    <div
      id={COMMAND_TIMELINE_ELEMENT_ID}
      tabIndex={-1}
      role="region"
      aria-label={t("title")}
      className="rounded-xl border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          {t("title")}
          <span className="text-xs font-normal text-muted-foreground">
            {stateLabel(command.state, t)}
          </span>
        </span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {open && (
        <div className="border-t px-4 py-4 space-y-3">
          <CommandSteps command={command} t={t} />

          <div className="text-xs text-muted-foreground space-y-0.5">
            <p>{t("createdAt", { time: formatTimestamp(command.createdAt) })}</p>
            {command.dispatchedAt && <p>{t("dispatchedAt", { time: formatTimestamp(command.dispatchedAt) })}</p>}
            {command.resolvedAt && <p>{t("resolvedAt", { time: formatTimestamp(command.resolvedAt) })}</p>}
          </div>

          {showExpiredHint && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{t("expiredHint")}</span>
            </div>
          )}

          {showReason && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">{t("reasonLabel")}</span>
              {" "}
              <span className="font-mono break-all">{command.reason}</span>
            </p>
          )}

          {isConflict && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
              <p className="text-xs text-amber-700 dark:text-amber-300">{tConflict("description")}</p>
              <div className="flex flex-col sm:flex-row gap-2 sm:justify-end">
                <Button variant="outline" size="sm" onClick={onDiscard} disabled={replaying}>
                  {tConflict("discard")}
                </Button>
                <Button size="sm" onClick={handleRefetchAndReplay} disabled={replaying} className="gap-1.5">
                  {replaying && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {tConflict("refetchAndReplay")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
