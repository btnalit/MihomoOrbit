"use client";

import { useState, useEffect, useRef, useCallback, type MouseEvent } from "react";
import { Check, Copy } from "lucide-react";
import { CopyToClipboard } from "react-copy-to-clipboard";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface DomainPreviewProps {
  domain?: string | null;
  unknownLabel: string;
  copyLabel: string;
  copiedLabel: string;
  interactive?: boolean;
  className?: string;
  triggerClassName?: string;
}

export function DomainPreview({
  domain,
  unknownLabel,
  copyLabel,
  copiedLabel,
  interactive = true,
  className,
  triggerClassName,
}: DomainPreviewProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const domainText = domain || unknownLabel;

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleTriggerClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleCopyResult = useCallback((_: string, result: boolean) => {
    if (result) {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
    } else {
      setCopied(false);
    }
  }, []);

  if (!interactive) {
    return (
      <div className={cn("min-w-0", className)}>
        <span
          className={cn(
            "block w-full min-w-0 truncate text-left text-sm font-medium text-foreground/95",
            triggerClassName,
          )}
        >
          {domainText}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", className)} onClick={(event) => event.stopPropagation()}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "w-full min-w-0 text-left font-medium truncate text-sm rounded-sm outline-none cursor-pointer underline-offset-4 decoration-dotted decoration-transparent hover:underline hover:decoration-muted-foreground/60 hover:text-foreground/95 focus-visible:ring-2 focus-visible:ring-ring/60",
              triggerClassName,
            )}
            onClick={handleTriggerClick}
          >
            {domainText}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          collisionPadding={12}
          className="w-[min(94vw,24rem)] rounded-lg border border-border/60 bg-popover/98 p-2 shadow-lg ring-1 ring-black/5 dark:bg-slate-950/94 dark:border-white/[0.08] dark:ring-0 dark:shadow-[0_14px_30px_rgba(0,0,0,0.46)]"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 max-h-24 overflow-auto rounded-md border border-border/55 bg-muted/35 px-2 py-1.5 text-[13px] leading-5 break-all dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-slate-100">
              {domainText}
            </code>
            {domain ? (
              <CopyToClipboard text={domain} onCopy={handleCopyResult}>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title={copied ? copiedLabel : copyLabel}
                  aria-label={copied ? copiedLabel : copyLabel}
                  className={cn(
                    "h-8 w-8 shrink-0 rounded-md border border-border/55 dark:border-white/[0.08] dark:bg-white/[0.02]",
                    copied
                      ? "text-emerald-600 bg-emerald-500/15 hover:bg-emerald-500/20 dark:text-emerald-400"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                  )}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </CopyToClipboard>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
