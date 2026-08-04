"use client";

import { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface OverviewCardProps {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
}

export function OverviewCard({ 
  title, 
  icon, 
  children, 
  action,
  footer
}: OverviewCardProps) {
  return (
    <Card className="flex flex-col h-full overflow-hidden border-border/50 bg-gradient-to-b from-card to-card/50">
      <CardHeader className="pb-3 space-y-0 flex-shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            {icon}
            {title}
          </CardTitle>
          {action && <div className="flex items-center">{action}</div>}
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col pt-0">
        <div className="flex-1">
          {children}
        </div>
        {footer && (
          <div className="mt-auto pt-4 border-t border-border/30">
            {footer}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
