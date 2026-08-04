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
