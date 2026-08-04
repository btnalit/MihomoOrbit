"use client";

import { useState, useEffect } from "react";
import { Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { getFaviconUrl, useSettings, type FaviconProvider } from "@/lib/settings";

interface FaviconProps {
  domain: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeMap = {
  sm: "w-5 h-5",
  md: "w-8 h-8",
  lg: "w-12 h-12",
};

const iconSizeMap = {
  sm: "w-3 h-3",
  md: "w-4 h-4",
  lg: "w-6 h-6",
};

// Generate gradient background based on domain
function getGradient(domain: string): string[] {
  const colors = [
    ["from-blue-500", "to-cyan-400"],
    ["from-purple-500", "to-pink-400"],
    ["from-emerald-500", "to-teal-400"],
    ["from-orange-500", "to-amber-400"],
    ["from-rose-500", "to-red-400"],
    ["from-indigo-500", "to-violet-400"],
  ];
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = domain.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// Clean domain (remove protocol, path, etc.)
function cleanDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

export function Favicon({ domain, size = "md", className }: FaviconProps) {
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const { settings } = useSettings();

  const cleanedDomain = cleanDomain(domain);
  const gradient = getGradient(cleanedDomain);

  const faviconUrl = getFaviconUrl(cleanedDomain, settings.faviconProvider);

  // Reset error state when provider changes
  useEffect(() => {
    setError(false);
    setLoading(true);
  }, [settings.faviconProvider, domain]);

  if (settings.faviconProvider === "off" || error || !cleanedDomain) {
    return (
      <div
        className={cn(
          "rounded-lg flex items-center justify-center bg-gradient-to-br",
          gradient,
          sizeMap[size],
          className
        )}
      >
        <Globe className={cn("text-white/90", iconSizeMap[size])} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg overflow-hidden bg-slate-800/50 flex items-center justify-center relative shrink-0",
        sizeMap[size],
        className
      )}
    >
      {loading && (
        <div
          className={cn(
            "absolute inset-0 bg-gradient-to-br",
            gradient
          )}
        />
      )}
      <img
        key={faviconUrl} // Force re-render when URL changes
        src={faviconUrl}
        alt={cleanedDomain}
        className={cn(
          "w-full h-full object-cover p-0.5",
          loading ? "opacity-0" : "opacity-100"
        )}
        onError={() => setError(true)}
        onLoad={() => setLoading(false)}
      />
    </div>
  );
}

// Fallback component for when favicon fails
export function DomainInitial({ domain, size = "md", className }: FaviconProps) {
  const cleaned = cleanDomain(domain);
  const initial = cleaned.charAt(0).toUpperCase();
  const gradient = getGradient(cleaned);

  return (
    <div
      className={cn(
        "rounded-lg flex items-center justify-center bg-gradient-to-br font-semibold text-white",
        gradient,
        sizeMap[size],
        size === "sm" ? "text-xs" : size === "lg" ? "text-xl" : "text-sm",
        className
      )}
    >
      {initial}
    </div>
  );
}
