"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BackendConfigDialog } from "@/components/features/backend";
import type { Backend } from "@/lib/api";

interface ConfigEditGateProps {
  backend: Backend | null | undefined;
  children: ReactNode;
  /** Forwarded to the gate's own BackendConfigDialog instance so saving an
   *  agent binding here refetches `backends` — without this the gate has
   *  no way to learn its own fix landed and stays degraded until the next
   *  unrelated refetch (or forever, with auto-refresh paused). Same
   *  rationale as ManagementGate's identically-named prop. */
  onBackendChange?: () => void;
}

/**
 * Capability gate for the M2 config editor tab. `backend.capabilities.
 * configEdit` is false whenever the backend has no bound agent (M1c's
 * `agentId === ''`) — in that case this renders a full-page degraded state
 * instead of `children`, same shape as `ManagementGate` (the M1 precedent
 * this deliberately mirrors structure- and prop-for-prop).
 */
export function ConfigEditGate({ backend, children, onBackendChange }: ConfigEditGateProps) {
  const t = useTranslations("configEditor.gate");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // `undefined` = the backends query hasn't resolved yet (cold load) — show
  // a lightweight skeleton instead of the degraded "unavailable" card, same
  // rationale as ManagementGate (avoids a flash on every first visit).
  if (backend === undefined) {
    return <ConfigEditGateSkeleton />;
  }

  const configEditEnabled = backend?.capabilities?.configEdit ?? false;

  if (configEditEnabled) {
    return <>{children}</>;
  }

  // Mirrors ManagementGate's isAgentMissingApiUrl split: an agent token can
  // be configured (`hasAgent`) without yet being explicitly bound to THIS
  // backend (`agentId`) — that case gets a more specific hint than the
  // generic "unavailable" message.
  const isAgentUnbound = !!backend?.hasAgent && !backend?.agentId;

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
              {isAgentUnbound ? t("agentHint") : t("unavailable")}
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

/** Same idiom as ManagementGateSkeleton: plain pulse blocks, no dependency
 *  on `backend` since none has resolved yet. */
function ConfigEditGateSkeleton() {
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
