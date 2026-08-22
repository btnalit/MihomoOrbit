"use client";

import { useState } from "react";
import { ChevronDown, Loader2, Search, X, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ExpandReveal } from "@/components/ui/expand-reveal";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MihomoProxy } from "@/lib/api";
import { DELAY_TIER_BAR_CLASSES, DelayBadge, delayTier, type DelayTier, type DelayValue } from "./delay-badge";

const SELECTABLE_GROUP_TYPE = "Selector";
// M1.7 T2: per-group node search only earns its keep past this member
// count — below it, scanning the (already small) grid by eye is faster
// than typing, and the header stays uncluttered for the common case.
const SEARCH_THRESHOLD = 10;
const ALL_TIERS: readonly DelayTier[] = ["low", "medium", "high", "unknown"];

interface GroupCardProps {
  group: MihomoProxy;
  proxies: Record<string, MihomoProxy>;
  overrideDelays: Map<string, DelayValue>;
  expanded: boolean;
  onToggleExpand: () => void;
  /** This group's delay test is in flight (from POST accept until the
   *  `delay` topic's `done: true` frame for this group). */
  testing: boolean;
  onTestGroup: () => void;
  onSelectProxy: (proxy: string) => void;
  /** Proxy name whose optimistic selection was just rolled back, if any. */
  selectFailedProxy?: string | null;
}

/** History last entry (resting delay), live-overridden by a `delay` topic
 *  event already merged into `overrideDelays` by the page. */
function resolveDelay(
  name: string,
  proxies: Record<string, MihomoProxy>,
  overrideDelays: Map<string, DelayValue>,
): DelayValue | undefined {
  const override = overrideDelays.get(name);
  if (override !== undefined) return override;
  const history = proxies[name]?.history;
  if (history && history.length > 0) {
    return history[history.length - 1]?.delay;
  }
  return undefined;
}

export function GroupCard({
  group,
  proxies,
  overrideDelays,
  expanded,
  onToggleExpand,
  testing,
  onTestGroup,
  onSelectProxy,
  selectFailedProxy,
}: GroupCardProps) {
  const t = useTranslations("management.groups");

  // M1.7 T2: per-card, page-local search — not lifted to GroupsPage (no
  // other card needs it) and not persisted anywhere. Collapsing the card
  // (expanded -> false) resets both below via the "adjust state during
  // render" pattern (React docs: "Resetting state when a prop changes") —
  // a `useEffect` doing the same setState-on-prop-change trip is flagged by
  // `react-hooks/set-state-in-effect` (see the same rule already
  // present/accepted elsewhere on this page, e.g. groups-page.tsx's
  // topicOffline effect); comparing against a tracked previous `expanded`
  // during render avoids that extra render pass entirely.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [prevExpanded, setPrevExpanded] = useState(expanded);
  if (expanded !== prevExpanded) {
    setPrevExpanded(expanded);
    if (!expanded) {
      setSearchOpen(false);
      setSearchQuery("");
    }
  }

  const members = group.all ?? [];
  const filteredMembers = searchOpen && searchQuery.trim()
    ? members.filter((name) => name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : members;
  const nowDelay = group.now ? resolveDelay(group.now, proxies, overrideDelays) : undefined;
  // Polish item ①: URLTest/Fallback/LoadBalance groups pick their own
  // member — manual selection is rejected upstream, so member buttons are
  // locked here instead of round-tripping a failed PUT. The group-level
  // delay-test button is unaffected and stays enabled for every group type
  // (see groups-page.tsx's handleTestGroup — no type check there).
  const locked = group.type !== SELECTABLE_GROUP_TYPE;

  // M1.7 T2: collapsed-card latency summary bar — bucket counts only, so
  // computed solely for the collapsed render path (the expanded path shows
  // every member's own DelayBadge instead). Same `resolveDelay` +
  // `delayTier` the expanded node cards use, so the two views can never
  // disagree about a given proxy's tier.
  const tierCounts = !expanded
    ? members.reduce<Record<DelayTier, number>>(
        (acc, name) => {
          const tier = delayTier(resolveDelay(name, proxies, overrideDelays));
          acc[tier] += 1;
          return acc;
        },
        { low: 0, medium: 0, high: 0, unknown: 0 },
      )
    : null;

  return (
    <Card data-testid="group-card" data-group-name={group.name}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {/* Polish item ③: 16px group icon, hidden on load failure so a
                  dead/blocked icon URL never leaves a broken-image glyph in
                  the card header. No referrer leaked to whatever host serves
                  the icon. */}
              {group.icon && (
                <img
                  src={group.icon}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="w-4 h-4 rounded-sm shrink-0"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              )}
              <h3 className="font-semibold truncate" title={group.name}>
                {group.name}
              </h3>
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground shrink-0">
                {group.type}
              </span>
            </div>
            <p className="text-sm text-muted-foreground mt-1 truncate">
              {group.now ? (
                <>
                  {t("current")}: <span className="text-foreground">{group.now}</span>
                </>
              ) : (
                t("noSelection")
              )}
            </p>
          </div>
          {group.now && <DelayBadge value={nowDelay} pending={testing} />}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t("memberCount", { count: members.length })}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={onTestGroup}
              disabled={testing}
            >
              {testing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              {testing ? t("testing") : t("test")}
            </Button>
            {/* M1.7 T2: only worth a header button past SEARCH_THRESHOLD
                members — hidden (not just disabled) below that so the
                header doesn't grow a control most groups never need. */}
            {expanded && members.length > SEARCH_THRESHOLD && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7"
                onClick={() => setSearchOpen((prev) => !prev)}
                aria-label={searchOpen ? t("closeSearch") : t("searchMembers")}
                aria-pressed={searchOpen}
              >
                {searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-7 w-7"
              onClick={onToggleExpand}
              aria-label={expanded ? t("collapse") : t("expand")}
              aria-expanded={expanded}
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")}
              />
            </Button>
          </div>
        </div>

        {selectFailedProxy && (
          <p className="text-xs text-rose-600 dark:text-rose-400">
            {t("selectFailed", { proxy: selectFailedProxy })}
          </p>
        )}

        {expanded && (
          <ExpandReveal>
            <div className="space-y-2 pt-1">
              {searchOpen && (
                <Input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("searchPlaceholder")}
                  aria-label={t("searchMembers")}
                  className="h-8 text-xs bg-secondary/50 border-0"
                />
              )}
              <TooltipProvider delayDuration={200}>
                {/* Zashboard-precedent layout (see plan's 调研结论): auto-fill
                    columns instead of a fixed 2/3-col grid, so wide cards get
                    more columns and narrow ones fewer without a breakpoint
                    table — and an internal scroll region so a 40+ member
                    group (e.g. GLOBAL) can't blow up page height. */}
                <div className="max-h-96 overflow-y-auto grid grid-cols-[repeat(auto-fill,minmax(min(140px,100%),1fr))] gap-1.5">
                  {filteredMembers.map((name) => {
                    const isSelected = name === group.now;
                    const delay = resolveDelay(name, proxies, overrideDelays);
                    // Data-driven, per §调研结论 — only render what the
                    // proxies record actually has for this member; nested
                    // groups and providers commonly lack `udp`.
                    const memberInfo = proxies[name];
                    const metaParts: string[] = [];
                    if (memberInfo?.type) metaParts.push(memberInfo.type);
                    if (memberInfo?.udp) metaParts.push("UDP");
                    const meta = metaParts.join(" · ");
                    // Native `disabled` suppresses hover/pointer events in
                    // Chromium, which would silently break the Radix tooltip
                    // below — `aria-disabled` + a guarded onClick keeps the
                    // button hoverable/focusable while still refusing the
                    // click, for both the locked (non-Selector group) and
                    // already-selected cases.
                    const blocked = isSelected || locked;
                    const button = (
                      <button
                        type="button"
                        onClick={() => {
                          if (!blocked) onSelectProxy(name);
                        }}
                        aria-disabled={blocked}
                        className={cn(
                          "flex flex-col gap-1 rounded-lg border px-2 py-1.5 text-left transition-colors",
                          isSelected
                            ? "border-primary bg-primary/5 text-foreground"
                            : locked
                              ? "border-border text-muted-foreground opacity-60 cursor-not-allowed"
                              : "border-border hover:bg-accent hover:text-accent-foreground",
                        )}
                      >
                        <span className="truncate text-sm">{name}</span>
                        <span className="flex items-center justify-between gap-1.5">
                          <span className="truncate text-[11px] text-muted-foreground">
                            {meta}
                          </span>
                          <DelayBadge value={delay} pending={testing} className="shrink-0" />
                        </span>
                      </button>
                    );

                    return (
                      <Tooltip key={name}>
                        <TooltipTrigger asChild>{button}</TooltipTrigger>
                        {locked && <TooltipContent side="top">{t("memberLocked")}</TooltipContent>}
                      </Tooltip>
                    );
                  })}
                </div>
              </TooltipProvider>
              {searchOpen && searchQuery.trim() !== "" && filteredMembers.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-2">
                  {t("noSearchResults")}
                </p>
              )}
            </div>
          </ExpandReveal>
        )}

        {/* M1.7 T2: collapsed-card latency summary — same tier thresholds
            and colors as the expanded DelayBadges (delayTier /
            DELAY_TIER_BAR_CLASSES), just proportional segments instead of
            per-member numbers so a folded card still says something at a
            glance. */}
        {tierCounts && members.length > 0 && (
          <div
            className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={t("delaySummaryLabel", {
              good: tierCounts.low,
              medium: tierCounts.medium,
              slow: tierCounts.high,
              unknown: tierCounts.unknown,
            })}
          >
            {ALL_TIERS.map((tier) =>
              tierCounts[tier] > 0 ? (
                <div
                  key={tier}
                  className={DELAY_TIER_BAR_CLASSES[tier]}
                  style={{ width: `${(tierCounts[tier] / members.length) * 100}%` }}
                />
              ) : null,
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
