export interface GeoIPInfo {
  countryCode: string;
  countryName: string;
  city: string;
  asOrganization: string;
}

type GeoIPLike =
  | GeoIPInfo
  | readonly unknown[]
  | Record<string, unknown>
  | null
  | undefined;

export function normalizeGeoIP(geoIP: unknown): GeoIPInfo | null {
  const value = geoIP as GeoIPLike;
  if (!value) return null;

  if (Array.isArray(value)) {
    const [countryCode, countryName, city, asOrganization] = value;
    const code = typeof countryCode === "string" ? countryCode : "";
    const name = typeof countryName === "string" ? countryName : code;
    const cityName = typeof city === "string" ? city : "";
    const org = typeof asOrganization === "string" ? asOrganization : "";
    if (!code && !name && !cityName && !org) {
      return null;
    }
    return {
      countryCode: code,
      countryName: name,
      city: cityName,
      asOrganization: org,
    };
  }

  const row = value as Partial<GeoIPInfo> & {
    country?: unknown;
    country_name?: unknown;
    as_name?: unknown;
  };

  const countryCode =
    typeof row.countryCode === "string"
      ? row.countryCode
      : typeof row.country === "string"
        ? row.country
        : "";
  const countryName =
    typeof row.countryName === "string"
      ? row.countryName
      : typeof row.country_name === "string"
        ? row.country_name
        : countryCode;
  const city = typeof row.city === "string" ? row.city : "";
  const asOrganization =
    typeof row.asOrganization === "string"
      ? row.asOrganization
      : typeof row.as_name === "string"
        ? row.as_name
        : "";

  if (!countryCode && !countryName && !city && !asOrganization) {
    return null;
  }

  return {
    countryCode,
    countryName,
    city,
    asOrganization,
  };
}
