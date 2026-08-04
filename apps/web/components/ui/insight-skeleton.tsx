"use client";

import { cn } from "@/lib/utils";

export function InsightThreePanelSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 md:grid-cols-2 xl:grid-cols-12 gap-6", className)}>
      <div className="min-w-0 md:col-span-1 xl:col-span-3 rounded-xl border border-dashed border-border/60 bg-card/30 p-4">
        <div className="h-4 w-24 rounded bg-muted/60 animate-pulse" />
        <div className="mt-4 flex justify-center">
          <div className="h-28 w-28 rounded-full border-8 border-muted/60 animate-pulse" />
        </div>
        <div className="mt-4 space-y-2">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-7 rounded-lg bg-muted/60 animate-pulse" />
          ))}
        </div>
      </div>

      <div className="min-w-0 md:col-span-1 xl:col-span-4 rounded-xl border border-dashed border-border/60 bg-card/30 p-4">
        <div className="h-4 w-28 rounded bg-muted/60 animate-pulse" />
        <div className="mt-4 space-y-2.5">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="h-12 rounded-xl bg-muted/60 animate-pulse" />
          ))}
        </div>
      </div>

      <div className="min-w-0 md:col-span-2 xl:col-span-5 rounded-xl border border-dashed border-border/60 bg-card/30 p-4">
        <div className="h-4 w-32 rounded bg-muted/60 animate-pulse" />
        <div className="mt-4 space-y-3">
          {[70, 85, 55, 90, 65].map((width, idx) => (
            <div key={idx} className="flex items-center gap-3">
              <div className="h-3 w-20 rounded bg-muted/50 animate-pulse" />
              <div
                className="h-6 rounded bg-muted/60 animate-pulse"
                style={{ width: `${width}%` }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function InsightChartSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-[280px] rounded-xl border border-dashed border-border/60 bg-card/30 px-4 py-5",
        className,
      )}
    >
      <div className="space-y-3">
        {[72, 88, 56, 92, 64].map((width, idx) => (
          <div key={idx} className="flex items-center gap-3">
            <div className="h-3 w-20 rounded bg-muted/50 animate-pulse" />
            <div
              className="h-6 rounded bg-muted/60 animate-pulse"
              style={{ width: `${width}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function InsightTableSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("px-4 py-6", className)}>
      <div className="min-h-[180px] rounded-xl border border-dashed border-border/60 bg-card/30 px-4 py-5">
        <div className="h-8 rounded-lg bg-muted/60 animate-pulse" />
        <div className="mt-2 space-y-2">
          {[0, 1, 2, 3, 4].map((item) => (
            <div key={item} className="h-10 rounded-lg bg-muted/60 animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function InsightDetailSectionSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-xl border border-border/50 bg-card", className)}>
      <div className="px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <div className="h-8 w-28 rounded-lg bg-muted/60 animate-pulse" />
          <div className="h-8 w-24 rounded-lg bg-muted/60 animate-pulse" />
        </div>
      </div>
      <InsightTableSkeleton className="py-4" />
    </div>
  );
}

// Backend list skeleton for Settings dialog
export function BackendListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="p-4 rounded-lg border border-border bg-card"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              {/* Icon skeleton */}
              <div className="w-8 h-8 rounded-lg bg-muted/60 animate-pulse shrink-0" />
              <div className="flex-1 min-w-0 space-y-2">
                {/* Name skeleton */}
                <div className="h-5 w-32 rounded bg-muted/60 animate-pulse" />
                {/* URL skeleton */}
                <div className="h-4 w-48 rounded bg-muted/50 animate-pulse" />
              </div>
            </div>
            {/* Actions skeleton */}
            <div className="flex items-center gap-2">
              <div className="h-8 w-16 rounded-full bg-muted/60 animate-pulse" />
              <div className="h-8 w-8 rounded-lg bg-muted/50 animate-pulse" />
              <div className="h-8 w-8 rounded-lg bg-muted/50 animate-pulse" />
              <div className="h-8 w-8 rounded-lg bg-muted/50 animate-pulse" />
            </div>
          </div>
        </div>
      ))}
      {/* Add button skeleton */}
      <div className="h-12 rounded-lg border border-dashed border-border bg-card/50 animate-pulse" />
    </div>
  );
}
