"use client";

import { ChevronDown, Loader2, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ExpandReveal } from "@/components/ui/expand-reveal";
import { cn } from "@/lib/utils";
import type { MihomoProxy } from "@/lib/api";
import { DelayBadge, type DelayValue } from "./delay-badge";

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

  const members = group.all ?? [];
  const nowDelay = group.now ? resolveDelay(group.now, proxies, overrideDelays) : undefined;

  return (
    <Card data-testid="group-card" data-group-name={group.name}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
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
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 pt-1">
              {members.map((name) => {
                const isSelected = name === group.now;
                const delay = resolveDelay(name, proxies, overrideDelays);
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => !isSelected && onSelectProxy(name)}
                    disabled={isSelected}
                    className={cn(
                      "flex items-center justify-between gap-1.5 rounded-lg border px-2 py-1.5 text-xs text-left transition-colors",
                      isSelected
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <span className="truncate">{name}</span>
                    <DelayBadge value={delay} pending={testing} className="shrink-0" />
                  </button>
                );
              })}
            </div>
          </ExpandReveal>
        )}
      </CardContent>
    </Card>
  );
}
