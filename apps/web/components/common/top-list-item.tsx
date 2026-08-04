"use client";

import { ReactNode } from "react";
import { formatBytes } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface TopListItemProps {
  rank: number;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  value: number;
  total: number;
  color?: string;
  showRank?: boolean;
  valueFormatter?: (value: number) => string;
  titleClassName?: string;
}

const RANK_COLORS: Record<number, string> = {
  1: "text-amber-500 bg-amber-500/10",
  2: "text-slate-400 bg-slate-400/10",
  3: "text-orange-600 bg-orange-600/10",
};

export function TopListItem({
  rank,
  icon,
  title,
  subtitle,
  value,
  total,
  color = "hsl(var(--primary))",
  showRank = true,
  valueFormatter,
  titleClassName,
}: TopListItemProps) {
  const percentage = total > 0 ? (value / total) * 100 : 0;
  const isTop3 = rank <= 3;

  const formatValue = (v: number) => {
    if (valueFormatter) return valueFormatter(v);
    return formatBytes(v);
  };

  return (
    <div className="group relative py-2.5 px-2 -mx-2 rounded-lg hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-3">
        {/* Rank Badge */}
        {showRank && (
          <div
            className={cn(
              "w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold shrink-0",
              isTop3 ? RANK_COLORS[rank] : "text-muted-foreground bg-muted"
            )}
          >
            {rank}
          </div>
        )}

        {/* Icon */}
        <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0 overflow-hidden">
          {icon}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className={cn("text-sm font-medium truncate", titleClassName)} title={title}>
                {title}
              </span>
              {subtitle && (
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  {subtitle}
                </span>
              )}
            </div>
            <span className="text-sm font-semibold tabular-nums shrink-0 ml-2">
              {formatValue(value)}
            </span>
          </div>

          {/* Progress Bar */}
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ 
                width: `${percentage}%`,
                backgroundColor: color,
                opacity: 0.7 + (percentage / 100) * 0.3
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// Compact version for smaller spaces
interface CompactTopItemProps {
  rank: number;
  icon: ReactNode;
  title: string;
  value: number;
  color?: string;
}

export function CompactTopItem({
  rank,
  icon,
  title,
  value,
  color = "hsl(var(--primary))",
}: CompactTopItemProps) {
  const isTop3 = rank <= 3;

  return (
    <div className="flex items-center gap-3 py-2">
      <span
        className={cn(
          "w-5 text-xs font-medium",
          isTop3 ? "text-amber-500" : "text-muted-foreground"
        )}
      >
        {rank}
      </span>
      <div className="w-6 h-6 rounded bg-muted/50 flex items-center justify-center shrink-0 overflow-hidden">
        {icon}
      </div>
      <span className="flex-1 text-sm truncate" title={title}>
        {title}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatBytes(value)}
      </span>
    </div>
  );
}
