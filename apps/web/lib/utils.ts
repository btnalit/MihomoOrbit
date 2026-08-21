import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals = 2): string {
  const normalizedBytes = Number(bytes);
  if (!Number.isFinite(normalizedBytes) || normalizedBytes === 0) return "0 B";
  if (normalizedBytes < 0) return `-${formatBytes(-normalizedBytes, decimals)}`;

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];

  const exponent = Math.log(normalizedBytes) / Math.log(k);
  const rawIndex = Number.isFinite(exponent) ? Math.floor(exponent) : 0;
  const i = rawIndex < 0 ? 0 : Math.min(rawIndex, sizes.length - 1);
  const unit = sizes[i] ?? "B";
  const scaled = normalizedBytes / Math.pow(k, i);
  const safeScaled = Number.isFinite(scaled) ? scaled : 0;

  return `${parseFloat(safeScaled.toFixed(dm))} ${unit}`;
}

export function formatNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toString();
}

// Exported (M2b Task 11): command-timeline.tsx/version-history.tsx need the
// exact same SQLite-timestamp-without-timezone handling as formatDuration
// below (server timestamps like "2026-08-09 12:00:00" or the ISO-without-Z
// variant must be parsed as UTC, not local time) but want an ABSOLUTE
// date/time string, not a relative "Xm ago" one — reusing this rather than
// duplicating the format-detection regexes.
export function parseApiTimestamp(dateString: string): Date {
  const raw = (dateString || "").trim();
  if (!raw) return new Date(Number.NaN);

  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw);
  if (hasTimezone) {
    return new Date(raw);
  }

  // Range-query rows may return minute keys like "2026-02-08T13:21:00"
  // without timezone info. Treat them as UTC to avoid local-time offsets.
  const isoNoTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(raw);
  if (isoNoTimezone) {
    return new Date(`${raw}Z`);
  }

  // SQLite CURRENT_TIMESTAMP style: "YYYY-MM-DD HH:MM:SS"
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw);
  if (sqliteUtc) {
    return new Date(raw.replace(" ", "T") + "Z");
  }

  return new Date(raw);
}

export function formatDuration(dateString: string): string {
  const date = parseApiTimestamp(dateString);
  if (Number.isNaN(date.getTime())) return "-";

  const now = new Date();
  const diff = Math.max(0, now.getTime() - date.getTime());

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

/** Absolute local date/time for a server timestamp — command-timeline.tsx's
 *  createdAt/dispatchedAt/resolvedAt and version-history.tsx's createdAt.
 *  `undefined` locale (browser default) matches the majority precedent
 *  elsewhere in this codebase (backend-health-chart.tsx, trend-chart.tsx),
 *  not next-intl's `useLocale()` (only time-range-picker.tsx ties date
 *  formatting to the app locale, for its own picker-specific reasons). */
export function formatTimestamp(dateString: string | null | undefined): string {
  if (!dateString) return "-";
  const date = parseApiTimestamp(dateString);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
