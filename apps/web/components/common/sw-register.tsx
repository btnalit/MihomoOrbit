"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";

export function ServiceWorkerRegister() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // Do not run SW in development, it interferes with HMR and tunnel debugging.
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          registrations.forEach((registration) => {
            registration.unregister().catch(() => {
              // Best effort cleanup only
            });
          });
        })
        .catch(() => {
          // Ignore cleanup failures in dev
        });
      return;
    }

    if ("serviceWorker" in navigator) {
      // Register service worker
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          // Check for updates
          registration.addEventListener("updatefound", () => {
            const newWorker = registration.installing;
            if (newWorker) {
              newWorker.addEventListener("statechange", () => {
                if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
                  // New version available
                  setUpdateAvailable(true);
                  setWaitingWorker(newWorker);
                }
              });
            }
          });
        })
        .catch(() => {
          // Silently fail - SW is optional enhancement
        });

      // Listen for messages from service worker
      const onMessage = (event: MessageEvent) => {
        if (event.data && event.data.type === "SKIP_WAITING") {
          window.location.reload();
        }
      };
      navigator.serviceWorker.addEventListener("message", onMessage);

      return () => {
        navigator.serviceWorker.removeEventListener("message", onMessage);
      };
    }
  }, []);

  const handleUpdate = () => {
    if (waitingWorker) {
      // Tell the service worker to skip waiting
      waitingWorker.postMessage({ type: "SKIP_WAITING" });
    }
    // Reload to activate new version
    window.location.reload();
  };

  if (!updateAvailable) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 animate-in slide-in-from-bottom-5 fade-in duration-300">
      <div className="bg-card border rounded-lg shadow-lg p-4 flex items-center gap-3 max-w-sm">
        <div className="flex-1">
          <p className="text-sm font-medium">Update Available</p>
          <p className="text-xs text-muted-foreground">A new version is ready</p>
        </div>
        <Button 
          size="sm" 
          onClick={handleUpdate}
          className="gap-1.5"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Update
        </Button>
      </div>
    </div>
  );
}
