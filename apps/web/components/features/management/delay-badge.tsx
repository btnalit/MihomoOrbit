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
 */

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type DelayValue = number | "timeout";

const TIER_CLASSES = {
  low: "border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  medium: "border-transparent bg-amber-500/10 text-amber-600 dark:text-amber-400",
  high: "border-transparent bg-rose-500/10 text-rose-600 dark:text-rose-400",
  unknown: "border-transparent bg-muted text-muted-foreground",
} as const;

function tierClassFor(value: DelayValue): string {
  if (value === "timeout" || value === 0) return TIER_CLASSES.unknown;
  if (value < 150) return TIER_CLASSES.low;
  if (value < 500) return TIER_CLASSES.medium;
  return TIER_CLASSES.high;
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

  return (
    <Badge variant="outline" className={cn(tierClassFor(value), className)}>
      {value}ms
    </Badge>
  );
}
