"use client";

import { Activity, Wifi, WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { ThemeToggle } from "./theme-toggle";
import { LanguageSwitcher } from "./language-switcher";
import { TimeRangePicker } from "./time-range-picker";
import type { TimeRange } from "@/lib/api";

interface HeaderProps {
  isConnected: boolean;
  timeRange?: TimeRange;
  onTimeRangeChange?: (range: TimeRange) => void;
}

export function Header({ 
  isConnected, 
  timeRange, 
  onTimeRangeChange,
}: HeaderProps) {
  const t = useTranslations("header");

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 max-w-7xl mx-auto items-center justify-between px-4 md:px-6">
        {/* Left: Logo + Connection Status */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center">
            <Activity className="h-6 w-6 text-primary" />
            {isConnected ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500"></span>
              </span>
            ) : (
              <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5 rounded-full bg-red-500"></span>
            )}
          </div>
          <div className="flex flex-col">
            <h1 className="text-lg font-semibold tracking-tight leading-none">{t("title")}</h1>
            <div className="flex items-center gap-1 mt-0.5">
              {isConnected ? (
                <>
                  <Wifi className="w-3 h-3 text-emerald-500" />
                  <span className="text-[10px] text-emerald-500 font-medium">已连接</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3 h-3 text-red-500" />
                  <span className="text-[10px] text-red-500 font-medium">未连接</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right: Controls */}
        <div className="flex items-center gap-2">
          {timeRange && onTimeRangeChange && (
            <TimeRangePicker
              value={timeRange}
              onChange={(range) => onTimeRangeChange(range)}
            />
          )}
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
