"use client";

import { Navigation } from "@/components/layout";
import type { BackendStatus } from "@/lib/types/dashboard";

interface SidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  onBackendChange: () => Promise<void>;
  backendStatus: BackendStatus;
}

export function Sidebar({
  activeTab,
  onTabChange,
  onBackendChange,
  backendStatus,
}: SidebarProps) {
  return (
    <Navigation
      activeTab={activeTab}
      onTabChange={onTabChange}
      onBackendChange={onBackendChange}
      backendStatus={backendStatus}
    />
  );
}
