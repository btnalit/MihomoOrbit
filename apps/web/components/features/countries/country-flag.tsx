import type { ComponentType, SVGProps } from "react";
import { Globe2, Home, Lock } from "lucide-react";
import { hasFlag } from "country-flag-icons";
import * as FlagIcons from "country-flag-icons/react/3x2";
import { cn } from "@/lib/utils";

const COUNTRY_CODE_ALIASES: Record<string, string> = {
  UK: "GB",
};

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  中国: "CN",
  美国: "US",
  日本: "JP",
  韩国: "KR",
  新加坡: "SG",
  香港: "HK",
  台湾: "TW",
  德国: "DE",
  英国: "GB",
  法国: "FR",
  澳大利亚: "AU",
  加拿大: "CA",
  俄罗斯: "RU",
  印度: "IN",
  荷兰: "NL",
  china: "CN",
  "united states": "US",
  japan: "JP",
  "south korea": "KR",
  singapore: "SG",
  "hong kong": "HK",
  taiwan: "TW",
  germany: "DE",
  "united kingdom": "GB",
  france: "FR",
  australia: "AU",
  canada: "CA",
  russia: "RU",
  india: "IN",
  netherlands: "NL",
};

type FlagCode = keyof typeof FlagIcons;

function toFlagCode(countryCode: string): FlagCode | null {
  if (!hasFlag(countryCode)) {
    return null;
  }
  return countryCode as FlagCode;
}

function normalizeCountryName(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  return COUNTRY_NAME_TO_CODE[normalized] ?? null;
}

function decodeRegionalFlag(flag: string): string | null {
  const chars = Array.from(flag);
  if (chars.length !== 2) {
    return null;
  }

  const base = 0x1f1e6;
  const codePoints = chars.map((char) => char.codePointAt(0));
  if (codePoints.some((point) => point === undefined)) {
    return null;
  }

  const letters = codePoints.map((point) => {
    const value = (point as number) - base + 65;
    return value >= 65 && value <= 90 ? String.fromCharCode(value) : null;
  });
  if (letters.some((letter) => letter === null)) {
    return null;
  }

  return letters.join("");
}

export function extractCountryCodeFromText(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  const fromFlag = value.match(/[\u{1f1e6}-\u{1f1ff}]{2}/u);
  if (fromFlag?.[0]) {
    return decodeRegionalFlag(fromFlag[0]);
  }
  return normalizeCountryCode(value);
}

export function stripLeadingFlagEmoji(value: string): string {
  return value.replace(/^[\u{1f1e6}-\u{1f1ff}]{2}\s*/u, "").trim();
}

export function normalizeCountryCode(country?: string | null): string | null {
  if (!country) {
    return null;
  }

  const raw = country.trim();
  if (!raw) {
    return null;
  }

  const upper = raw.toUpperCase();
  if (upper === "LOCAL" || upper === "DIRECT" || upper === "UNKNOWN" || upper === "PRIVATE") {
    return upper;
  }

  if (COUNTRY_CODE_ALIASES[upper]) {
    return COUNTRY_CODE_ALIASES[upper];
  }

  if (/^[A-Z]{2}$/.test(upper)) {
    return upper;
  }

  const normalizedName = normalizeCountryName(raw);
  if (normalizedName) {
    return normalizedName;
  }

  return null;
}

interface CountryFlagProps {
  country?: string | null;
  className?: string;
  title?: string;
}

export function CountryFlag({ country, className, title }: CountryFlagProps) {
  const normalized = normalizeCountryCode(country);

  if (normalized === "LOCAL" || normalized === "DIRECT") {
    return <Home className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", className)} aria-hidden="true" />;
  }

  if (normalized === "PRIVATE") {
    return <Lock className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", className)} aria-hidden="true" />;
  }

  const flagCode = normalized ? toFlagCode(normalized) : null;
  if (flagCode) {
    const Flag = FlagIcons[flagCode] as ComponentType<SVGProps<SVGSVGElement>>;
    return (
      <Flag
        aria-label={title ?? normalized ?? undefined}
        className={cn("inline-block h-3.5 w-5 shrink-0 rounded-[3px]", className)}
      />
    );
  }

  return <Globe2 className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", className)} aria-hidden="true" />;
}
