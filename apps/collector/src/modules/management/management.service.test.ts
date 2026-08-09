import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ManagementService } from './management.service.js';
import type { TopicHub } from '../websocket/topic-hub.js';
import { createTestDatabase } from '../../__tests__/helpers.js';
import type { StatsDatabase } from '../db/db.js';

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

interface PublishedAppend {
  topic: string;
  backendId: number;
  json: string;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
  });
}

// Fake Mihomo: GET /proxies, PUT /proxies/:name, GET /proxies/:name/delay,
// DELETE /connections/:id, GET|PATCH /configs. Records every request it
// receives and can be told to hang (never respond) to exercise the
// AbortSignal.timeout -> reachable:false path.
function createFakeMihomo(state: { requests: RecordedRequest[]; hang: boolean }): http.Server {
  return http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '';

    void (async () => {
      const body = method === 'PUT' || method === 'PATCH' ? await readJsonBody(req) : undefined;
      state.requests.push({ method, url, body });

      if (state.hang) {
        // Never respond — exercises the upstream-timeout path.
        return;
      }

      if (method === 'GET' && url === '/proxies') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          proxies: {
            GLOBAL: { name: 'GLOBAL', type: 'Selector', all: ['B-Group', 'A-Group'] },
            'A-Group': { name: 'A-Group', type: 'Selector', all: ['N1', 'N2'], history: [] },
            'B-Group': { name: 'B-Group', type: 'Selector', all: ['N1'], history: [] },
            N1: { name: 'N1', type: 'Shadowsocks', history: [] },
            N2: { name: 'N2', type: 'Shadowsocks', history: [] },
          },
        }));
        return;
      }

      if (method === 'PUT' && /^\/proxies\/[^/]+$/.test(url)) {
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === 'GET' && /^\/proxies\/[^/]+\/delay/.test(url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ delay: 87 }));
        return;
      }

      if (method === 'DELETE' && /^\/connections\/[^/]+$/.test(url)) {
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === 'GET' && url === '/configs') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ port: 7890 }));
        return;
      }

      if (method === 'PATCH' && url === '/configs') {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    })();
  });
}

describe('ManagementService', () => {
  let db: StatsDatabase;
  let cleanupDb: () => void;
  let published: PublishedAppend[];
  let hub: TopicHub;
  let svc: ManagementService;
  let upstream: http.Server;
  let upstreamState: { requests: RecordedRequest[]; hang: boolean };
  let backendId: number;

  beforeEach(async () => {
    upstreamState = { requests: [], hang: false };
    upstream = createFakeMihomo(upstreamState);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    ({ db, cleanup: cleanupDb } = createTestDatabase());

    published = [];
    // Stub built as a standalone const before the cast — an inline
    // `{...} as unknown as TopicHub` on the return/assignment expression
    // collapses `this` in method-shorthand bodies under this project's
    // strict TS config (see Task 1 report finding #3); assigning first
    // avoids that.
    const hubStub = {
      publishAppend: (topic: string, id: number, json: string) => {
        published.push({ topic, backendId: id, json });
      },
    };
    hub = hubStub as unknown as TopicHub;

    svc = new ManagementService({ db, hub });

    backendId = db.createBackend({
      name: 'mgmt-test',
      url: `ws://127.0.0.1:${upstreamPort}/connections`,
      token: '',
      apiUrl: `http://127.0.0.1:${upstreamPort}`,
      apiSecret: '',
    });
  });

  afterEach(async () => {
    cleanupDb();
    upstream.closeAllConnections?.();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('resolve refuses a backend without api_url with NO_MANAGEMENT_CAPABILITY', () => {
    const id = db.createBackend({ name: 'agent-only', url: 'agent://a', token: 't', agentToken: 't' });
    const r = svc.resolve(id);
    expect(r).toMatchObject({ ok: false, status: 409, body: { code: 'NO_MANAGEMENT_CAPABILITY' } });
  });

  it('fetchGroups returns only entries with an `all` list, ordered by GLOBAL.all', async () => {
    const { groups } = await svc.fetchGroups(backendId);
    expect((groups as Array<{ name: string }>).map((g) => g.name)).toEqual(['GLOBAL', 'B-Group', 'A-Group']);
  });

  it('selectProxy PUTs the url-encoded group name with { name } body', async () => {
    await svc.selectProxy(backendId, '特殊/组', 'HK-01');
    expect(upstreamState.requests).toContainEqual(
      expect.objectContaining({ method: 'PUT', url: '/proxies/%E7%89%B9%E6%AE%8A%2F%E7%BB%84', body: { name: 'HK-01' } }),
    );
  });

  it('group delay test fans out per member, publishes one delay event each plus done', async () => {
    const r = await svc.startGroupDelayTest(backendId, 'A-Group');
    expect(r).toMatchObject({ accepted: true, total: 2 });
    await vi.waitFor(() => expect(published.filter((p) => p.topic === 'delay')).toHaveLength(3)); // 2 results + done
    expect(published.at(-1)!.json).toContain('"done":true');
  });

  it('second concurrent test on the same group is rejected', async () => {
    await svc.startGroupDelayTest(backendId, 'A-Group');
    expect(await svc.startGroupDelayTest(backendId, 'A-Group'))
      .toMatchObject({ accepted: false, code: 'DELAY_TEST_RUNNING' });
  });

  it('upstream timeout maps to a structured unreachable error', async () => {
    upstreamState.hang = true;
    await expect(svc.fetchGroups(backendId)).rejects.toMatchObject({ reachable: false });
  });

  // Coverage beyond the brief's 6 mandated cases, for the remaining service methods.
  it('testDelay returns the upstream delay value', async () => {
    const result = await svc.testDelay(backendId, 'N1');
    expect(result).toEqual({ delay: 87 });
  });

  it('killConnection DELETEs the url-encoded connection id', async () => {
    await svc.killConnection(backendId, 'conn/1');
    expect(upstreamState.requests).toContainEqual(
      expect.objectContaining({ method: 'DELETE', url: '/connections/conn%2F1' }),
    );
  });

  it('getConfigs/patchConfigs proxy the upstream configs endpoint', async () => {
    const configs = await svc.getConfigs(backendId);
    expect(configs).toEqual({ port: 7890 });

    await svc.patchConfigs(backendId, { mode: 'rule' });
    expect(upstreamState.requests).toContainEqual(
      expect.objectContaining({ method: 'PATCH', url: '/configs', body: { mode: 'rule' } }),
    );
  });
});
