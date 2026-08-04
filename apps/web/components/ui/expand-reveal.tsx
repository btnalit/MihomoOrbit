"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ExpandRevealProps {
  children: ReactNode;
  className?: string;
}

export function ExpandReveal({ children, className }: ExpandRevealProps) {
  return (
    <div
      className={cn(
        "overflow-hidden motion-reduce:animate-none animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out",
        className,
      )}
    >
      {children}
    </div>
  );
}
