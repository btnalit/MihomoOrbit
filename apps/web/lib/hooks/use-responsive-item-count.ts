"use client";

import { useState, useEffect } from "react";

interface UseResponsiveItemCountOptions {
  /** Default/base number of items to show (mobile/small screens) */
  defaultCount?: number;
  /** Number of items to show on large screens */
  largeScreenCount?: number;
  /** Minimum viewport height to be considered "large screen" (in pixels) */
  minHeightThreshold?: number;
}

/**
 * Hook to determine how many items to display based on viewport height.
 * Useful for responsive list/grid components that should show more content
 * on larger screens while keeping a compact view on smaller screens.
 */
export function useResponsiveItemCount({
  defaultCount = 5,
  largeScreenCount = 10,
  minHeightThreshold = 1100,
}: UseResponsiveItemCountOptions = {}) {
  const [itemCount, setItemCount] = useState(defaultCount);

  useEffect(() => {
    const updateCount = () => {
      const viewportHeight = window.innerHeight;
      setItemCount(
        viewportHeight >= minHeightThreshold ? largeScreenCount : defaultCount
      );
    };

    // Initial check
    updateCount();

    // Listen for resize events
    window.addEventListener("resize", updateCount);

    return () => {
      window.removeEventListener("resize", updateCount);
    };
  }, [defaultCount, largeScreenCount, minHeightThreshold]);

  return itemCount;
}
