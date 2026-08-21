"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BackendConfigDialog } from "@/components/features/backend";
import type { Backend } from "@/lib/api";

interface ManagementGateProps {
  backend: Backend | null | undefined;
  children: ReactNode;
  /** Forwarded to the gate's own BackendConfigDialog instance so saving an
   *  `api_url` here refetches `backends` — without this the gate has no way
   *  to learn its own fix landed and stays degraded until the next
   *  unrelated refetch (or forever, with auto-refresh paused). */
  onBackendChange?: () => void;
}

/**
 * Capability gate for the five M1/M1.5 management pages (groups/connections/
 * logs/runtime/providers). `backend.capabilities.management` is false whenever the
 * backend has no `api_url` configured (M1c) — in that case this renders a
 * full-page degraded state instead of `children`, per the spec's M1b
 * first-run script. Two variants: a backend that already reports via an
 * agent just needs its API address filled in; anything else gets the
 * generic unavailable message. Both offer a shortcut into the existing
 * backend settings dialog, reusing the same open/onOpenChange mechanism
 * `components/layout/navigation.tsx` uses for its own settings button.
 */
export function ManagementGate({ backend, children, onBackendChange }: ManagementGateProps) {
  const t = useTranslations("management.gate");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // `undefined` = the backends query hasn't resolved yet (cold load) — show
  // a lightweight skeleton instead of the degraded "unavailable" card, which
  // would otherwise flash on every first visit and read as a real capability
  // failure rather than a loading state. `null` (resolved, no backend) still
  // falls through to the degraded card below, same as before this fix.
  if (backend === undefined) {
    return <ManagementGateSkeleton />;
  }

  const managementEnabled = backend?.capabilities?.management ?? false;

  if (managementEnabled) {
    return <>{children}</>;
  }

  const isAgentMissingApiUrl = !!backend?.hasAgent && !backend?.apiUrl;

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-4">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center text-center gap-4 p-8">
          <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-amber-500/10">
            <AlertCircle className="w-7 h-7 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="space-y-1.5">
            <h3 className="text-lg font-semibold">{t("title")}</h3>
            <p className="text-sm text-muted-foreground">
              {isAgentMissingApiUrl ? t("agentHint") : t("unavailable")}
            </p>
          </div>
          <Button onClick={() => setSettingsOpen(true)} className="gap-2">
            <Settings className="w-4 h-4" />
            {t("openSettings")}
          </Button>
        </CardContent>
      </Card>

      <BackendConfigDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        isFirstTime={false}
        onBackendChange={onBackendChange}
      />
    </div>
  );
}

/** Same idiom as the per-page skeletons (groups-page.tsx's
 *  GroupsPageSkeleton, runtime-page.tsx's RuntimePageSkeleton): plain pulse
 *  blocks, no dependency on `backend` since none has resolved yet. */
function ManagementGateSkeleton() {
  return (
    <div className="flex items-center justify-center min-h-[60vh] p-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 flex flex-col items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-muted/50 animate-pulse" />
        <div className="space-y-2 w-full flex flex-col items-center">
          <div className="h-4 w-40 rounded bg-muted/60 animate-pulse" />
          <div className="h-3 w-56 rounded bg-muted/40 animate-pulse" />
        </div>
        <div className="h-9 w-36 rounded-md bg-muted/50 animate-pulse" />
      </div>
    </div>
  );
}
