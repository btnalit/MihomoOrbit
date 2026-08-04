"use client";

import { ChevronRight, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsWindows } from "@/lib/hooks/use-is-windows";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ProxyChainBadgeProps {
  chains?: string[] | null;
  truncateLabel?: boolean;
  interactive?: boolean;
  wrapperClassName?: string;
  badgeClassName?: string;
  countClassName?: string;
  emptyClassName?: string;
}

function ChainFlow({
  chain,
  isWindows,
  mobile = false,
}: {
  chain: string;
  isWindows: boolean;
  mobile?: boolean;
}) {
  const segments = chain
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean);

  // Backend stores full chain as "proxy > ... > rule", display as "rule > ... > proxy".
  const displaySegments = segments.length > 1 ? [...segments].reverse() : segments;

  const getNodeTone = (idx: number, total: number) => {
    if (idx === 0) {
      return "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-200 dark:border-violet-400/35 dark:bg-violet-500/20";
    }
    if (idx === total - 1) {
      return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200 dark:border-emerald-400/40 dark:bg-emerald-500/20";
    }
    return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-200 dark:border-blue-400/35 dark:bg-blue-500/20";
  };

  const getLinkTone = (idx: number, total: number) => {
    if (idx === 0) {
      return {
        line: "bg-gradient-to-r from-violet-400/80 to-blue-400/80 dark:from-violet-300/80 dark:to-blue-300/80",
        dot: "bg-blue-500/80 dark:bg-blue-300/90",
      };
    }
    if (idx === total - 2) {
      return {
        line: "bg-gradient-to-r from-blue-400/80 to-emerald-400/80 dark:from-blue-300/80 dark:to-emerald-300/80",
        dot: "bg-emerald-500/80 dark:bg-emerald-300/90",
      };
    }
    return {
      line: "bg-gradient-to-r from-blue-400/80 to-blue-300/80 dark:from-blue-300/80 dark:to-blue-200/80",
      dot: "bg-blue-500/80 dark:bg-blue-300/90",
    };
  };

  if (mobile) {
    return (
      <div className="space-y-1">
        {displaySegments.map((segment, idx) => (
          <div key={`${segment}-${idx}`}>
            <span
              className={cn(
                "block w-full px-2 py-1 rounded-md border text-[11px] font-medium break-words",
                isWindows && "emoji-flag-font",
                getNodeTone(idx, displaySegments.length),
              )}
            >
              {segment}
            </span>
            {idx < displaySegments.length - 1 && (
              <div className="flex justify-center py-0.5">
                <ChevronRight className="h-3.5 w-3.5 rotate-90 text-muted-foreground/70" />
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-0.5">
      <div className="inline-flex items-center gap-1.5 min-w-max">
      {displaySegments.map((segment, idx) => (
        <span key={`${segment}-${idx}`} className="inline-flex items-center gap-1">
          <span
            className={cn(
              "px-2 py-0.5 rounded-md border text-[11px] font-medium whitespace-nowrap",
              isWindows && "emoji-flag-font",
              getNodeTone(idx, displaySegments.length),
            )}
          >
            {segment}
          </span>
          {idx < displaySegments.length - 1 && (
            <span className="relative inline-flex items-center w-6 h-3.5 shrink-0">
              <span
                className={cn(
                  "h-[2px] w-full rounded-full",
                  getLinkTone(idx, displaySegments.length).line,
                )}
              />
              <span
                className={cn(
                  "absolute left-1/2 -translate-x-1/2 h-1.5 w-1.5 rounded-full animate-pulse",
                  getLinkTone(idx, displaySegments.length).dot,
                )}
              />
              <ChevronRight className="absolute -right-1 h-3 w-3 text-muted-foreground/70 shrink-0" />
            </span>
          )}
        </span>
      ))}
      </div>
    </div>
  );
}

export function ProxyChainBadge({
  chains,
  truncateLabel = true,
  interactive = true,
  wrapperClassName,
  badgeClassName,
  countClassName,
  emptyClassName,
}: ProxyChainBadgeProps) {
  const isWindows = useIsWindows();

  if (!chains || chains.length === 0) {
    return <span className={cn("text-xs text-muted-foreground", emptyClassName)}>-</span>;
  }

  const firstChain = chains[0];
  const landingProxy = firstChain.split(">").map((p) => p.trim()).filter(Boolean)[0] || firstChain;
  const triggerClassName = cn(
    "inline-flex items-center gap-1.5 min-w-0",
    wrapperClassName,
  );
  const labelClassName = cn(
    "inline-flex items-center gap-1 rounded-md bg-secondary/60 text-foreground dark:bg-secondary/40 dark:text-foreground/80 text-[11px] font-medium",
    isWindows && "emoji-flag-font",
    truncateLabel
      ? "px-1.5 py-0.5 truncate max-w-[180px] lg:max-w-[220px]"
      : "px-2 py-0.5 whitespace-nowrap",
    badgeClassName,
  );
  const extraCount = chains.length > 1 ? (
    <span className={cn("text-[11px] text-muted-foreground shrink-0", countClassName)}>
      +{chains.length - 1}
    </span>
  ) : null;
  const renderLabel = () => (
    <>
      <span className={labelClassName}>
        <Waypoints className="h-2.5 w-2.5 shrink-0" />
        {landingProxy}
      </span>
      {extraCount}
    </>
  );

  const renderTrigger = () => (
    <button
      type="button"
      className={triggerClassName}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {renderLabel()}
    </button>
  );
  const renderChainDetails = (mobile = false) => (
    <div className="max-h-[280px] overflow-auto pr-1 space-y-1.5">
      {chains.map((chain, idx) => (
        <div
          key={`${chain}-${idx}`}
          className={cn(
            "rounded-md border border-border/70 bg-card/85 text-card-foreground px-2 py-1.5 dark:border-white/[0.08] dark:bg-white/[0.02]",
            idx > 0 && "mt-1",
          )}
        >
          <div className="flex items-center gap-2">
            {chains.length > 1 && (
              <span className="inline-flex items-center justify-center h-5 min-w-5 px-1 rounded-full bg-muted/80 text-[10px] font-semibold text-muted-foreground shrink-0 dark:bg-white/[0.06] dark:text-slate-300">
                {idx + 1}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <ChainFlow chain={chain} isWindows={isWindows} mobile={mobile} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  if (!interactive) {
    return (
      <span className={triggerClassName}>
        {renderLabel()}
      </span>
    );
  }

  return (
    <>
      <span className="hidden sm:inline-flex">
        <TooltipProvider delayDuration={250}>
          <Tooltip>
            <TooltipTrigger asChild>{renderTrigger()}</TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              className="max-w-[560px] p-2 border border-border/70 bg-popover/98 text-popover-foreground shadow-xl ring-1 ring-black/5 dark:bg-slate-950/94 dark:border-white/[0.08] dark:ring-0 dark:shadow-[0_14px_30px_rgba(0,0,0,0.46)]"
            >
              {renderChainDetails(false)}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>

      <span className="sm:hidden inline-flex">
        <Popover>
          <PopoverTrigger asChild>{renderTrigger()}</PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="w-[min(94vw,24rem)] p-2 border border-border/70 bg-popover/98 text-popover-foreground shadow-xl ring-1 ring-black/5 dark:bg-slate-950/94 dark:border-white/[0.08] dark:ring-0 dark:shadow-[0_14px_30px_rgba(0,0,0,0.46)]"
            onClick={(event) => event.stopPropagation()}
          >
            {renderChainDetails(true)}
          </PopoverContent>
        </Popover>
      </span>
    </>
  );
}
