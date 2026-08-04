"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { CopyToClipboard } from "react-copy-to-clipboard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CopyIconButtonProps {
  value: string;
  copyLabel: string;
  copiedLabel: string;
  className?: string;
  disabled?: boolean;
}

export function CopyIconButton({
  value,
  copyLabel,
  copiedLabel,
  className,
  disabled = false,
}: CopyIconButtonProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  if (disabled) {
    return (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled
        className={cn(
          "h-8 w-8 shrink-0 rounded-md border border-border/55 text-muted-foreground/60 dark:border-white/[0.08] dark:bg-white/[0.02]",
          className,
        )}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    );
  }

  return (
    <CopyToClipboard
      text={value}
      onCopy={(_, result) => {
        if (result) {
          setCopied(true);
          if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
        }
      }}
    >
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
          className,
        )}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </CopyToClipboard>
  );
}
