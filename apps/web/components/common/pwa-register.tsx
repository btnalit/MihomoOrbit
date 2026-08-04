"use client";

import { useEffect } from "react";

export function PWARegister() {
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      "serviceWorker" in navigator
    ) {
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          console.log("SW registered: ", registration.scope);

          // Check for updates periodically (every 60 minutes)
          setInterval(
            () => {
              registration.update();
            },
            60 * 60 * 1000,
          );
        })
        .catch((error) => {
          console.log("SW registration failed: ", error);
        });
    }
  }, []);

  return null;
}
