"use client";

import { type ReactNode } from "react";

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Auth is handled globally by AuthGuard in the root layout.
  // This layout is kept as a pass-through for potential future
  // dashboard-specific layout needs.
  return <>{children}</>;
}
