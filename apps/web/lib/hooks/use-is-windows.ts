"use client";

import { useState, useEffect } from "react";

export function useIsWindows(): boolean {
  const [isWindows, setIsWindows] = useState(false);

  useEffect(() => {
    const userAgent = window.navigator.userAgent.toLowerCase();
    setIsWindows(userAgent.includes("windows"));
  }, []);

  return isWindows;
}
