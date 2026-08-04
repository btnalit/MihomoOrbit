"use client";

import { useState, useEffect, useRef, useCallback, type MouseEvent } from "react";
import { Building2, Check, Copy, MapPin, Network, Server } from "lucide-react";
import { CopyToClipboard } from "react-copy-to-clipboard";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CountryFlag } from "@/components/features/countries/country-flag";
import { cn } from "@/lib/utils";
import { useCountryName } from "@/lib/i18n-country";
import { normalizeGeoIP, type GeoIPInfo } from "@neko-master/shared";

interface IPPreviewProps {
  ip?: string | null;
  geoIP?: GeoIPInfo | null;
  asn?: string | null;
  unknownLabel: string;
  unavailableLabel: string;
  copyLabel: string;
  copiedLabel: string;
  locationLabel: string;
  cityLabel: string;
  asnLabel: string;
  asOrganizationLabel: string;
  interactive?: boolean;
  className?: string;
  triggerClassName?: string;
}

export function IPPreview({
  ip,
  geoIP,
  asn,
  unknownLabel,
  unavailableLabel,
  copyLabel,
  copiedLabel,
  locationLabel,
  cityLabel,
  asnLabel,
  asOrganizationLabel,
  interactive = true,
  className,
  triggerClassName,
}: IPPreviewProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ipText = ip || unknownLabel;

  const geo = normalizeGeoIP(geoIP);
  const countryCode = geo?.countryCode;
  const localizedName = useCountryName();
  const city = geo?.city || unavailableLabel;
  const asOrganization = geo?.asOrganization || unavailableLabel;
  const asnValue = asn || unavailableLabel;
  const hasLocation = Boolean(countryCode);
  const displayLocation = countryCode ? localizedName(countryCode) : unavailableLabel;

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleTriggerClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleCopyResult = useCallback((_: string, result: boolean) => {
    if (result) {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
    } else {
      setCopied(false);
    }
  }, []);

  if (!interactive) {
    return (
      <div className={cn("min-w-0", className)}>
        <span
          className={cn(
            "block w-full min-w-0 truncate text-left text-sm text-foreground/95",
            triggerClassName,
          )}
        >
          {ipText}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", className)} onClick={(event) => event.stopPropagation()}>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "w-full min-w-0 text-left truncate text-sm rounded-sm outline-none cursor-pointer underline-offset-4 decoration-dotted decoration-transparent hover:underline hover:decoration-muted-foreground/60 hover:text-foreground/95 focus-visible:ring-2 focus-visible:ring-ring/60",
              triggerClassName,
            )}
            onClick={handleTriggerClick}
          >
            {ipText}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          collisionPadding={12}
          className="w-[min(94vw,25rem)] rounded-lg border border-border/60 bg-popover/98 p-2.5 shadow-lg ring-1 ring-black/5 dark:bg-slate-950/94 dark:border-white/[0.08] dark:ring-0 dark:shadow-[0_14px_30px_rgba(0,0,0,0.46)]"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 rounded-md border border-border/55 bg-muted/35 px-2 py-1.5 text-[13px] leading-5 break-all dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-slate-100">
                {ipText}
              </code>
              {ip ? (
                <CopyToClipboard text={ip} onCopy={handleCopyResult}>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    title={copied ? copiedLabel : copyLabel}
                    aria-label={copied ? copiedLabel : copyLabel}
                    className={cn(
                      "h-8 w-8 shrink-0 rounded-md border border-border/55 dark:border-white/[0.08] dark:bg-white/[0.02]",
                      copied
                        ? "text-emerald-600 bg-emerald-500/15 hover:bg-emerald-500/20 dark:text-emerald-400"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                    )}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </CopyToClipboard>
              ) : null}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              <div className="min-h-[70px] rounded-md border border-border/55 bg-card/70 px-2.5 py-2 dark:border-white/[0.08] dark:bg-white/[0.02]">
                <p className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <MapPin className="h-3 w-3" />
                  {locationLabel}
                </p>
                {hasLocation ? (
                  <span className="mt-1.5 flex min-w-0 items-center gap-1.5">
                    <CountryFlag country={countryCode || "UN"} className="h-3.5 w-5" />
                    <span className="truncate text-sm font-medium leading-5">{displayLocation}</span>
                  </span>
                ) : (
                  <span className="mt-1.5 block truncate text-sm leading-5 text-muted-foreground">{unavailableLabel}</span>
                )}
              </div>

              <div className="min-h-[70px] rounded-md border border-border/55 bg-card/70 px-2.5 py-2 dark:border-white/[0.08] dark:bg-white/[0.02]">
                <p className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Building2 className="h-3 w-3" />
                  {cityLabel}
                </p>
                <span title={city} className="mt-1.5 block truncate text-sm font-medium leading-5">{city}</span>
              </div>

              <div className="min-h-[70px] rounded-md border border-border/55 bg-card/70 px-2.5 py-2 dark:border-white/[0.08] dark:bg-white/[0.02]">
                <p className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Network className="h-3 w-3" />
                  {asnLabel}
                </p>
                <span className="mt-1.5 block truncate text-sm font-semibold tabular-nums leading-5">{asnValue}</span>
              </div>

              <div className="min-h-[70px] rounded-md border border-border/55 bg-card/70 px-2.5 py-2 dark:border-white/[0.08] dark:bg-white/[0.02]">
                <p className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Server className="h-3 w-3" />
                  {asOrganizationLabel}
                </p>
                <span title={asOrganization} className="mt-1.5 block truncate text-sm font-medium leading-5">{asOrganization}</span>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
