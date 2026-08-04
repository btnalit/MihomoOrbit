import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestBackend, createTestDatabase } from "../../__tests__/helpers.js";
import type { StatsDatabase } from "./db.js";
import type { IPStats } from "@neko-master/shared";

describe("StatsDatabase geoIP normalization", () => {
  let db: StatsDatabase;
  let cleanup: () => void;
  let backendId: number;

  beforeEach(() => {
    ({ db, cleanup } = createTestDatabase());
    backendId = createTestBackend(db);
  });

  afterEach(() => {
    cleanup();
  });

  it("normalizes legacy geoIP array to structured object in getIPStats", () => {
    const repoSpy = vi.spyOn(db.repos.ip, "getIPStats").mockReturnValue([
      {
        ip: "1.1.1.1",
        domains: ["example.com"],
        totalUpload: 1,
        totalDownload: 2,
        totalConnections: 3,
        lastSeen: "2026-02-16T00:00:00.000Z",
        geoIP: ["US", "United States", "Dallas", "IBM Cloud"] as any,
      } as IPStats,
    ]);

    const result = db.getIPStats(backendId, 10);
    expect(result).toHaveLength(1);
    expect(result[0].geoIP).toEqual({
      countryCode: "US",
      countryName: "United States",
      city: "Dallas",
      asOrganization: "IBM Cloud",
    });

    repoSpy.mockRestore();
  });

  it("keeps structured geoIP and normalizes mixed payloads in paginated results", () => {
    const repoSpy = vi.spyOn(db.repos.ip, "getIPStatsPaginated").mockReturnValue({
      data: [
        {
          ip: "2.2.2.2",
          domains: [],
          totalUpload: 10,
          totalDownload: 20,
          totalConnections: 2,
          lastSeen: "2026-02-16T00:00:00.000Z",
          geoIP: {
            countryCode: "JP",
            countryName: "Japan",
            city: "Tokyo",
            asOrganization: "IIJ",
          },
        } as IPStats,
        {
          ip: "3.3.3.3",
          domains: [],
          totalUpload: 11,
          totalDownload: 22,
          totalConnections: 3,
          lastSeen: "2026-02-16T00:00:00.000Z",
          geoIP: ["KR", "South Korea", "", ""] as any,
        } as IPStats,
      ],
      total: 2,
    });

    const result = db.getIPStatsPaginated(backendId, {
      offset: 0,
      limit: 10,
    });

    expect(result.total).toBe(2);
    expect(result.data[0].geoIP).toEqual({
      countryCode: "JP",
      countryName: "Japan",
      city: "Tokyo",
      asOrganization: "IIJ",
    });
    expect(result.data[1].geoIP).toEqual({
      countryCode: "KR",
      countryName: "South Korea",
      city: "",
      asOrganization: "",
    });

    repoSpy.mockRestore();
  });

  it("normalizes geoIP for wrapped detail methods like getRuleDomainIPDetails", () => {
    const repoSpy = vi.spyOn(db.repos.rule, "getRuleDomainIPDetails").mockReturnValue([
      {
        ip: "4.4.4.4",
        domains: ["a.com"],
        totalUpload: 5,
        totalDownload: 6,
        totalConnections: 1,
        lastSeen: "2026-02-16T00:00:00.000Z",
        geoIP: ["SG", "Singapore", "Singapore", "Singtel"] as any,
      } as IPStats,
    ]);

    const result = db.getRuleDomainIPDetails(
      backendId,
      "DOMAIN-SUFFIX(google.com)",
      "google.com",
      undefined,
      undefined,
      10,
    );

    expect(result[0].geoIP).toEqual({
      countryCode: "SG",
      countryName: "Singapore",
      city: "Singapore",
      asOrganization: "Singtel",
    });

    repoSpy.mockRestore();
  });
});
