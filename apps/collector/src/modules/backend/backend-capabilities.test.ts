import { describe, it, expect } from 'vitest';
import { backendCapabilities } from '@mihomo-orbit/shared';

// M0 只交付能力契约:判定函数 + 后端列表 API 上的 capabilities 字段。
// 签名吃「后端记录」而非 url 字符串,是为了让 M1c(统一后端模型)只改实现、
// 不改签名与调用点——届时 agent:// 判据会被 agent_id 取代。
describe('backendCapabilities', () => {
  it('direct clash backend: management yes, configEdit no', () => {
    expect(backendCapabilities({ url: 'http://192.168.1.1:9090' })).toEqual({
      monitoring: true,
      management: true,
      configEdit: false,
    });
  });

  it('agent backend: management no (until M1c), configEdit yes', () => {
    expect(backendCapabilities({ url: 'agent://main-router' })).toEqual({
      monitoring: true,
      management: false,
      configEdit: true,
    });
  });

  it('accepts a record so M1c can add agentBound without changing callers', () => {
    expect(backendCapabilities({ url: 'http://192.168.1.1:9090', agentBound: true }).configEdit).toBe(true);
  });

  it('monitoring is unconditional', () => {
    for (const url of ['http://x:9090', 'https://x:9090', 'agent://x', '']) {
      expect(backendCapabilities({ url }).monitoring).toBe(true);
    }
  });

  it('agent:// matching is case-insensitive and tolerates whitespace', () => {
    expect(backendCapabilities({ url: '  AGENT://Router  ' }).configEdit).toBe(true);
  });
});

describe('backendCapabilities (M1c unified model)', () => {
  it('management follows api_url presence, not url scheme', () => {
    expect(backendCapabilities({ url: 'agent://router', apiUrl: 'http://10.0.0.1:9090', agentToken: 't', agentId: 'a1' }))
      .toEqual({ monitoring: true, management: true, configEdit: true });
    expect(backendCapabilities({ url: 'agent://router', apiUrl: '', agentToken: 't', agentId: 'a1' }))
      .toEqual({ monitoring: true, management: false, configEdit: true });
  });
  it('configEdit requires an explicitly bound agent, not just a token', () => {
    expect(backendCapabilities({ url: 'http://x:9090', apiUrl: 'http://x:9090', agentToken: 't', agentId: '' }).configEdit)
      .toBe(false);
  });
  it('legacy M0 shape (url only) keeps its old behavior', () => {
    expect(backendCapabilities({ url: 'http://x:9090' }))
      .toEqual({ monitoring: true, management: true, configEdit: false });
    expect(backendCapabilities({ url: 'agent://r' }))
      .toEqual({ monitoring: true, management: false, configEdit: true });
  });
});
