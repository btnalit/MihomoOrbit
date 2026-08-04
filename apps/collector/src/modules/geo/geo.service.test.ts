import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app/app.js";
import { realtimeStore } from "../realtime/realtime.store.js";
import { createTestBackend, createTestDatabase } from "../../__tests__/helpers.js";
import type { StatsDatabase } from "../db/db.js";
import type { FastifyInstance } from "fastify";

describe("GeoIP config API", () => {
  let db: StatsDatabase;
  let cleanup: () => void;
  let backendId: number;
  let app: FastifyInstance;
  let mmdbDir: string;
  const originalEnv = {
    GEOIP_MMDB_DIR: process.env.GEOIP_MMDB_DIR,
    GEOIP_LOOKUP_PROVIDER: process.env.GEOIP_LOOKUP_PROVIDER,
    GEOIP_ONLINE_API_URL: process.env.GEOIP_ONLINE_API_URL,
  };

  beforeEach(async () => {
    mmdbDir = fs.mkdtempSync(path.join(os.tmpdir(), "geoip-mmdb-"));
    process.env.GEOIP_MMDB_DIR = mmdbDir;
    delete process.env.GEOIP_LOOKUP_PROVIDER;
    delete process.env.GEOIP_ONLINE_API_URL;

    ({ db, cleanup } = createTestDatabase());
    backendId = createTestBackend(db);
    app = await createApp({
      port: 0,
      db,
      realtimeStore,
      logger: false,
      autoListen: false,
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    realtimeStore.clearBackend(backendId);
    cleanup();
    fs.rmSync(mmdbDir, { recursive: true, force: true });

    if (originalEnv.GEOIP_MMDB_DIR === undefined) delete process.env.GEOIP_MMDB_DIR;
    else process.env.GEOIP_MMDB_DIR = originalEnv.GEOIP_MMDB_DIR;
    if (originalEnv.GEOIP_LOOKUP_PROVIDER === undefined) delete process.env.GEOIP_LOOKUP_PROVIDER;
    else process.env.GEOIP_LOOKUP_PROVIDER = originalEnv.GEOIP_LOOKUP_PROVIDER;
    if (originalEnv.GEOIP_ONLINE_API_URL === undefined) delete process.env.GEOIP_ONLINE_API_URL;
    else process.env.GEOIP_ONLINE_API_URL = originalEnv.GEOIP_ONLINE_API_URL;
  });

  it("GET /api/db/geoip is side-effect-free and reports configured/effective providers", async () => {
    db.updateGeoLookupConfig({ provider: "local" });

    const before = db.getGeoLookupConfig();
    expect(before.provider).toBe("local");
    expect(before.localMmdbReady).toBe(false);

    const response = await app.inject({
      method: "GET",
      url: "/api/db/geoip",
    });
    expect(response.statusCode).toBe(200);

    const payload = response.json() as {
      provider: "online" | "local";
      configuredProvider: "online" | "local";
      effectiveProvider: "online" | "local";
      localMmdbReady: boolean;
    };
    expect(payload.provider).toBe("local");
    expect(payload.configuredProvider).toBe("local");
    expect(payload.effectiveProvider).toBe("online");
    expect(payload.localMmdbReady).toBe(false);

    // GET should never mutate stored config.
    const after = db.getGeoLookupConfig();
    expect(after.provider).toBe("local");
  });

  it("PUT /api/db/geoip rejects local provider when required MMDB files are missing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/db/geoip",
      payload: { provider: "local" },
    });

    expect(response.statusCode).toBe(400);
    const payload = response.json() as {
      error: string;
      missingMmdbFiles?: string[];
    };
    expect(payload.error).toContain("Local MMDB is not ready");
    expect(payload.missingMmdbFiles).toEqual(
      expect.arrayContaining(["GeoLite2-City.mmdb", "GeoLite2-ASN.mmdb"]),
    );
  });

  it("PUT /api/db/geoip accepts local provider when required MMDB files exist", async () => {
    fs.writeFileSync(path.join(mmdbDir, "GeoLite2-City.mmdb"), "");
    fs.writeFileSync(path.join(mmdbDir, "GeoLite2-ASN.mmdb"), "");

    const response = await app.inject({
      method: "PUT",
      url: "/api/db/geoip",
      payload: { provider: "local" },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      config: {
        provider: "online" | "local";
        configuredProvider: "online" | "local";
        effectiveProvider: "online" | "local";
        localMmdbReady: boolean;
      };
    };
    expect(payload.config.provider).toBe("local");
    expect(payload.config.configuredProvider).toBe("local");
    expect(payload.config.effectiveProvider).toBe("local");
    expect(payload.config.localMmdbReady).toBe(true);
  });
});
