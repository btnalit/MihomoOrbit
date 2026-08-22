"use client";

/**
 * Latency pill for a single proxy/group member. Value comes from the
 * group's `history` last entry (resting delay) unless live-overridden by a
 * `delay` topic event for the same proxy name — see `groups-page.tsx`.
 *
 * Color tiers per m1-realtime-management task-5 brief: <150ms green,
 * <500ms yellow, else red, timeout/error gray. `0` is additionally treated
 * as "no data" (gray) — Mihomo's own convention for "never tested / dead",
 * matching zashboard's `NOT_CONNECTED` constant (helper/index.ts).
 *
 * `DELAY_LOW_MS`/`DELAY_MEDIUM_MS` and `delayTier()` are exported (M1.7 T2)
 * so the groups-page collapsed summary bar buckets members by the exact
 * same thresholds this badge colors by — they must never disagree about a
 * given proxy's tier. `DELAY_TIER_BAR_CLASSES` mirrors `TIER_CLASSES`' hues
 * as solid fills for that bar (no text to keep legible over, so no need for
 * the translucent background this badge uses).
 */

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type DelayValue = number | "timeout";

export const DELAY_LOW_MS = 150;
export const DELAY_MEDIUM_MS = 500;

export type DelayTier = "low" | "medium" | "high" | "unknown";

/** Buckets a resolved delay (or `undefined` = no data yet) into the same
 *  tier this badge colors by. */
export function delayTier(value: DelayValue | undefined): DelayTier {
  if (value === undefined || value === "timeout" || value === 0) return "unknown";
  if (value < DELAY_LOW_MS) return "low";
  if (value < DELAY_MEDIUM_MS) return "medium";
  return "high";
}

const TIER_CLASSES = {
  low: "border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  medium: "border-transparent bg-amber-500/10 text-amber-600 dark:text-amber-400",
  high: "border-transparent bg-rose-500/10 text-rose-600 dark:text-rose-400",
  unknown: "border-transparent bg-muted text-muted-foreground",
} as const;

/** Solid-fill counterpart of `TIER_CLASSES`, for the collapsed-card summary
 *  bar (M1.7 T2) — same emerald/amber/rose hues with dark variants, gray
 *  for the not-connected bucket. */
export const DELAY_TIER_BAR_CLASSES: Record<DelayTier, string> = {
  low: "bg-emerald-500 dark:bg-emerald-400",
  medium: "bg-amber-500 dark:bg-amber-400",
  high: "bg-rose-500 dark:bg-rose-400",
  unknown: "bg-muted-foreground/30",
};

function tierClassFor(value: DelayValue): string {
  return TIER_CLASSES[delayTier(value)];
}

interface DelayBadgeProps {
  /** Resolved delay for this proxy; `undefined` = no data yet. */
  value: DelayValue | undefined;
  /** Group-level test in flight and no result has landed for this member yet. */
  pending?: boolean;
  className?: string;
}

export function DelayBadge({ value, pending, className }: DelayBadgeProps) {
  const t = useTranslations("management.groups");

  if (value === undefined && pending) {
    return (
      <Badge variant="outline" className={cn(TIER_CLASSES.unknown, className)}>
        <Loader2 className="h-3 w-3 animate-spin" />
      </Badge>
    );
  }

  if (value === undefined) {
    return (
      <Badge variant="outline" className={cn(TIER_CLASSES.unknown, className)}>
        —
      </Badge>
    );
  }

  if (value === "timeout") {
    return (
      <Badge variant="outline" className={cn(TIER_CLASSES.unknown, className)}>
        {t("timeout")}
      </Badge>
    );
  }

  if (value === 0) {
    return (
      <Badge variant="outline" className={cn(TIER_CLASSES.unknown, className)}>
        —
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className={cn(tierClassFor(value), className)}>
      {value}ms
    </Badge>
  );
}
