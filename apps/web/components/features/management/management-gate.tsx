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
}

/**
 * Capability gate for the four M1 management pages (groups/connections/
 * logs/runtime). `backend.capabilities.management` is false whenever the
 * backend has no `api_url` configured (M1c) — in that case this renders a
 * full-page degraded state instead of `children`, per the spec's M1b
 * first-run script. Two variants: a backend that already reports via an
 * agent just needs its API address filled in; anything else gets the
 * generic unavailable message. Both offer a shortcut into the existing
 * backend settings dialog, reusing the same open/onOpenChange mechanism
 * `components/layout/navigation.tsx` uses for its own settings button.
 */
export function ManagementGate({ backend, children }: ManagementGateProps) {
  const t = useTranslations("management.gate");
  const [settingsOpen, setSettingsOpen] = useState(false);

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
      />
    </div>
  );
}
