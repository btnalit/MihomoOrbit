import { useMemo } from "react";
import type { TimeRange } from "@/lib/api";

/**
 * Stabilizes a TimeRange object reference so that downstream consumers
 * (e.g. react-query keys) only see a new reference when the actual
 * start/end values change.
 */
export function useStableTimeRange(
  timeRange?: TimeRange,
  options?: { roundToMinute?: boolean },
): TimeRange | undefined {
  return useMemo<TimeRange | undefined>(() => {
    if (!timeRange?.start && !timeRange?.end) return undefined;
    const start = new Date(timeRange.start);
    const end = new Date(timeRange.end);
    if (options?.roundToMinute) {
      start.setUTCSeconds(0, 0);
      end.setUTCSeconds(0, 0);
    }
    return { start: start.toISOString(), end: end.toISOString() };
  }, [timeRange?.start, timeRange?.end, options?.roundToMinute]);
}
