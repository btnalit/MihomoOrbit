"use client";

import { useMemo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { Globe, Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CountryFlag } from "./country-flag";
import { formatBytes, formatNumber } from "@/lib/utils";
import { useCountryName } from "@/lib/i18n-country";
import type { CountryStats } from "@neko-master/shared";

interface CountryTrafficChartProps {
  data: CountryStats[];
}

// Continent colors
const CONTINENT_COLORS: Record<string, string> = {
  AS: "#F59E0B", // Asia - Amber
  NA: "#3B82F6", // North America - Blue
  EU: "#8B5CF6", // Europe - Purple
  SA: "#10B981", // South America - Emerald
  AF: "#EF4444", // Africa - Red
  OC: "#06B6D4", // Oceania - Cyan
  LOCAL: "#6B7280", // Local - Gray
  Unknown: "#9CA3AF", // Unknown - Gray
};

// Get color for continent
function getContinentColor(continent: string): string {
  return CONTINENT_COLORS[continent] || CONTINENT_COLORS.Unknown;
}

export function CountryTrafficChart({ data }: CountryTrafficChartProps) {
  const t = useTranslations("countries");
  const mapT = useTranslations("map");
  const countryName = useCountryName();

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.map((country) => ({
      name: countryName(country.country),
      code: country.country,
      value: country.totalDownload + country.totalUpload,
      download: country.totalDownload,
      upload: country.totalUpload,
      connections: country.totalConnections,
      continent: country.continent,
      color: getContinentColor(country.continent),
    }));
  }, [data, countryName]);

  const totalTraffic = useMemo(() => {
    return chartData.reduce((sum, item) => sum + item.value, 0);
  }, [chartData]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const item = payload[0].payload;
      return (
        <div className="glass-card p-3 rounded-lg border shadow-lg">
          <div className="flex items-center gap-2 mb-2">
            <CountryFlag country={item.code} className="h-4 w-6" />
            <span className="font-medium text-sm">{item.name}</span>
          </div>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{mapT("total")}:</span>
              <span className="font-medium">{formatBytes(item.value)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-blue-500">↓ {mapT("download")}:</span>
              <span>{formatBytes(item.download)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-purple-500">↑ {mapT("upload")}:</span>
              <span>{formatBytes(item.upload)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-emerald-500">{mapT("connections")}:</span>
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
          <Globe className="h-5 w-5 text-primary" />
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
                dataKey="value"
              >
                {chartData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Country Cards Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {chartData.map((item) => {
            const percentage = totalTraffic > 0 ? (item.value / totalTraffic) * 100 : 0;
            
            return (
              <div
                key={item.code}
                className="p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-card transition-colors"
              >
                {/* Header: Flag + Name */}
                <div className="flex items-center gap-2 mb-2">
                  <CountryFlag country={item.code} className="h-4 w-6" />
                  <p className="font-medium text-sm truncate" title={item.name}>
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
                      style={{ width: `${percentage}%`, backgroundColor: item.color }}
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
                    <span>{formatNumber(item.connections)} {t("connections")}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground pt-2 border-t border-border">
          <span className="font-medium">{t("continents")}</span>
          {Object.entries(CONTINENT_COLORS)
            .filter(([key]) => key !== "Unknown" && key !== "LOCAL")
            .map(([continent, color]) => (
              <span key={continent} className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                {continent}
              </span>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
