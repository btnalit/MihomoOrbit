"use client";

/**
 * Shared pagination bar for management pages (connections/logs). Mirrors
 * `stats/table/domain-stats-table.tsx`'s pagination bar exactly — same
 * markup, same page-size `DropdownMenu` (Rows3 icon), same windowed
 * page-number buttons via `lib/stats-utils.ts`'s `getPageNumbers` — so the
 * base app's paging idiom (not the dead `ui/pagination.tsx` scaffolding)
 * reads identically everywhere it appears. Purely presentational: callers
 * own `page`/`pageSize` state and any reset/clamp rules for their own data
 * source (live churn differs per page — connections vs. logs).
 */

import { ChevronLeft, ChevronRight, Rows3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PAGE_SIZE_OPTIONS, getPageNumbers, type PageSize } from "@/lib/stats-utils";

interface PaginationBarProps {
  /** Already clamped into `[1, totalPages]` by the caller — rendered as-is. */
  page: number;
  pageSize: PageSize;
  totalItems: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
  /** Translated word appended after the page-size number, e.g. "页" / "page"
   *  — mirrors domain-stats-table's `{pageSize} / {t("page")}` wording. */
  pageWord: string;
}

export function PaginationBar({
  page,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
  pageWord,
}: PaginationBarProps) {
  if (totalItems === 0) return null;

  const startIndex = Math.min((page - 1) * pageSize + 1, totalItems);
  const endIndex = Math.min(page * pageSize, totalItems);

  return (
    <div className="p-3 border-t border-border/50 bg-secondary/20">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
              >
                <Rows3 className="h-4 w-4" />
                <span>{pageSize} / {pageWord}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {PAGE_SIZE_OPTIONS.map((size) => (
                <DropdownMenuItem
                  key={size}
                  onClick={() => onPageSizeChange(size)}
                  className={pageSize === size ? "bg-primary/10" : ""}
                >
                  {size} / {pageWord}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex flex-col sm:flex-row items-center gap-1 sm:gap-2">
          <p className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
            {startIndex}-{endIndex} / {totalItems}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {getPageNumbers(page, totalPages).map((p, idx) =>
              p === "..." ? (
                <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground text-xs">
                  ...
                </span>
              ) : (
                <Button
                  key={p}
                  variant={page === p ? "default" : "ghost"}
                  size="sm"
                  className="h-8 w-8 px-0 text-xs"
                  onClick={() => onPageChange(p as number)}
                >
                  {p}
                </Button>
              ),
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
