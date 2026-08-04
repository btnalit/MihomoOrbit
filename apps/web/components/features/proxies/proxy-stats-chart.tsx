"use client";

import { useMemo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { Server, Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatNumber, cn } from "@/lib/utils";
import { useIsWindows } from "@/lib/hooks/use-is-windows";
import type { ProxyStats } from "@neko-master/shared";

interface ProxyStatsChartProps {
  data: ProxyStats[];
}

const COLORS = [
  "#3B82F6",
  "#8B5CF6",
  "#06B6D4",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#EC4899",
  "#6366F1",
  "#14B8A6",
  "#F97316",
];

// Format proxy name for display
function formatProxyName(name: string): string {
  if (!name) return "DIRECT";
  const normalized = name.replace(/^\["?/, "").replace(/"?\]$/, "").trim();
  const parts = normalized
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[0] || normalized;
}

export function ProxyStatsChart({ data }: ProxyStatsChartProps) {
  const t = useTranslations("proxies");
  const isWindows = useIsWindows();

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.map((proxy, index) => ({
      name: formatProxyName(proxy.chain),
      rawName: proxy.chain,
      value: proxy.totalDownload + proxy.totalUpload,
      download: proxy.totalDownload,
      upload: proxy.totalUpload,
      connections: proxy.totalConnections,
      color: COLORS[index % COLORS.length],
    }));
  }, [data]);

  const totalTraffic = useMemo(() => {
    return chartData.reduce((sum, item) => sum + item.value, 0);
  }, [chartData]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const item = payload[0].payload;
      return (
        <div className="glass-card p-3 rounded-lg border shadow-lg">
          <p className={cn("font-medium text-sm mb-2", isWindows && "emoji-flag-font")}>{item.name}</p>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t("total")}:</span>
              <span className="font-medium">{formatBytes(item.value)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-blue-500">↓ {t("download")}:</span>
              <span>{formatBytes(item.download)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-purple-500">↑ {t("upload")}:</span>
              <span>{formatBytes(item.upload)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-emerald-500">{t("connections")}:</span>
              <span>{formatNumber(item.connections)}</span>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Server className="h-5 w-5 text-primary" />
          {t("distribution")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Pie Chart at Top */}
        <div className="h-[220px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={80}
                paddingAngle={2}
                dataKey="value">
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Proxy Cards Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {chartData.map((item) => {
            const percentage =
              totalTraffic > 0 ? (item.value / totalTraffic) * 100 : 0;

            return (
              <div
                key={item.rawName}
                className="p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-card transition-colors">
                {/* Header: Color dot + Name */}
                <div className="flex items-center gap-2 mb-2">
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: item.color }}
                  />
                  <p className={cn("font-medium text-sm truncate", isWindows && "emoji-flag-font")} title={item.name}>
                    {item.name}
                  </p>
                </div>

                {/* Traffic Stats */}
                <div className="space-y-2">
                  {/* Total with percentage */}
                  <div className="flex items-baseline justify-between">
                    <span className="text-lg font-bold tabular-nums">
                      {formatBytes(item.value)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {percentage.toFixed(1)}%
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${percentage}%`,
                        backgroundColor: item.color,
                      }}
                    />
                  </div>

                  {/* Download/Upload row */}
                  <div className="flex items-center justify-between text-xs pt-1">
                    <span className="text-blue-500 tabular-nums">
                      ↓ {formatBytes(item.download)}
                    </span>
                    <span className="text-purple-500 tabular-nums">
                      ↑ {formatBytes(item.upload)}
                    </span>
                  </div>

                  {/* Connections */}
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Link2 className="w-3 h-3" />
                    <span>
                      {formatNumber(item.connections)} {t("connections")}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
