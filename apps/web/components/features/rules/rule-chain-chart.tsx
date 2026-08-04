"use client";

import { useMemo } from "react";
import { Network, ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatNumber } from "@/lib/utils";
import type { RuleStats } from "@neko-master/shared";

interface RuleChainChartProps {
  data: RuleStats[];
}

const COLORS = [
  "#3B82F6", "#8B5CF6", "#06B6D4", "#10B981", "#F59E0B",
  "#EF4444", "#EC4899", "#6366F1", "#14B8A6", "#F97316",
];

function formatRuleName(rule: string): string {
  if (!rule) return "DIRECT";
  return rule
    .replace(/^\["?/, "")
    .replace(/"?\]$/, "")
    .replace(/^✈️\s*/, "")
    .replace(/^🚀\s*/, "")
    .replace(/^📹\s*/, "")
    .replace(/^🚚\s*/, "")
    .replace(/^🏠\s*/, "")
    .replace(/^🐟\s*/, "")
    .replace(/^📲\s*/, "")
    .replace(/^🎮\s*/, "")
    .replace(/^💼\s*/, "")
    .replace(/^🌐\s*/, "")
    .replace(/^🎵\s*/, "")
    .replace(/^🍎\s*/, "")
    .trim();
}

function getRuleEmoji(rule: string): string {
  if (rule.includes("✈️")) return "✈️";
  if (rule.includes("🚀")) return "🚀";
  if (rule.includes("📹")) return "📹";
  if (rule.includes("🚚")) return "🚚";
  if (rule.includes("🏠")) return "🏠";
  if (rule.includes("🐟")) return "🐟";
  if (rule.includes("📲")) return "📲";
  if (rule.includes("🎮")) return "🎮";
  if (rule.includes("💼")) return "💼";
  if (rule.includes("🌐")) return "🌐";
  if (rule.includes("🎵")) return "🎵";
  if (rule.includes("🍎")) return "🍎";
  return "🔗";
}

function formatProxyName(proxy: string): string {
  if (!proxy) return "DIRECT";
  return proxy
    .replace(/^\["?/, "")
    .replace(/"?\]$/, "")
    .trim();
}

export function RuleChainChart({ data }: RuleChainChartProps) {
  const t = useTranslations("rules");

  const rules = useMemo(() => {
    if (!data) return [];
    return data.map((rule, index) => ({
      ...rule,
      color: COLORS[index % COLORS.length],
      formattedRule: formatRuleName(rule.rule),
      formattedProxy: formatProxyName(rule.finalProxy),
      emoji: getRuleEmoji(rule.rule),
      total: rule.totalUpload + rule.totalDownload,
    }));
  }, [data]);

  const totalTraffic = useMemo(() => {
    return rules.reduce((sum, r) => sum + r.total, 0);
  }, [rules]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Network className="h-5 w-5 text-primary" />
          {t("distribution")}
        </CardTitle>
        <p className="text-sm text-muted-foreground mt-1">
          {t("description")}
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {rules.map((rule) => {
            const percentage = totalTraffic > 0 ? (rule.total / totalTraffic) * 100 : 0;

            return (
              <div
                key={rule.rule}
                className="p-3 rounded-lg border border-border/50 hover:bg-secondary/20 transition-colors"
              >
                {/* Top Row: Chain Flow + Traffic */}
                <div className="flex items-center gap-2 sm:gap-3">
                  {/* Rule Icon */}
                  <div
                    className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center shrink-0"
                    style={{ backgroundColor: `${rule.color}15` }}
                  >
                    <span className="text-sm sm:text-base">{rule.emoji}</span>
                  </div>

                  {/* Rule Name + Proxy (stacked on mobile) */}
                  <div className="flex-1 min-w-0 hidden sm:flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm truncate" title={rule.formattedRule}>
                        {rule.formattedRule}
                      </p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm text-muted-foreground truncate" title={rule.formattedProxy}>
                        {rule.formattedProxy}
                      </p>
                    </div>
                  </div>

                  {/* Mobile: stacked names */}
                  <div className="flex-1 min-w-0 sm:hidden">
                    <p className="font-medium text-sm truncate" title={rule.formattedRule}>
                      {rule.formattedRule}
                    </p>
                    <p className="text-xs text-muted-foreground truncate flex items-center gap-1" title={rule.formattedProxy}>
                      <ArrowRight className="w-3 h-3 shrink-0" />
                      {rule.formattedProxy}
                    </p>
                  </div>

                  {/* Traffic Stats */}
                  <div className="text-right shrink-0 min-w-[70px] sm:min-w-[100px]">
                    <p className="font-semibold text-sm tabular-nums">
                      {formatBytes(rule.total)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {percentage.toFixed(1)}%
                    </p>
                  </div>
                </div>

                {/* Second Row: Progress Bar + Detailed Stats */}
                <div className="mt-2 sm:mt-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                  {/* Progress Bar */}
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${percentage}%`, backgroundColor: rule.color }}
                    />
                  </div>

                  {/* Detailed Stats */}
                  <div className="flex items-center gap-3 sm:gap-4 text-xs text-muted-foreground shrink-0">
                    <span className="tabular-nums">{formatNumber(rule.totalConnections)} {t("connections")}</span>
                    <span className="tabular-nums text-blue-500">↓ {formatBytes(rule.totalDownload)}</span>
                    <span className="tabular-nums text-purple-500">↑ {formatBytes(rule.totalUpload)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
