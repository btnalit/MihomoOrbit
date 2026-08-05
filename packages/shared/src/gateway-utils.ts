/**
 * Gateway API 工具函数
 * 用于处理 Clash/Surge 后端的通用逻辑
 */

export type BackendType = 'clash' | 'surge';

export interface BackendConfig {
  id: number;
  name: string;
  url: string;
  token: string;
  type: BackendType;
  enabled: boolean;
  is_active: boolean;
  listening: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * 构建 Gateway API 请求头
 */
export function buildGatewayHeaders(
  backend: Pick<BackendConfig, 'type' | 'token'>,
  extraHeaders: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...extraHeaders,
  };

  if (backend.token) {
    if (backend.type === 'surge') {
      headers['x-key'] = backend.token;
    } else {
      headers['Authorization'] = `Bearer ${backend.token}`;
    }
  }

  return headers;
}

/**
 * 解析 Surge 规则字符串
 * 支持格式: TYPE,PAYLOAD,POLICY 或 TYPE,POLICY
 */
export function parseSurgeRule(raw: string): { type: string; payload: string; policy: string } | null {
  const trimmed = raw.trim();
  
  // Skip empty lines and comments
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const parts = trimmed.split(',').map(p => p.trim());
  if (parts.length < 2) {
    return null;
  }

  const type = parts[0];
  
  // Helper to remove surrounding quotes from policy names
  const unquote = (str: string) => str?.replace(/^["']|["']$/g, '') || '';
  
  // Handle different rule types
  if (type === 'FINAL') {
    return { type: 'MATCH', payload: '*', policy: unquote(parts[1]) || 'DIRECT' };
  }
  
  if (type === 'GEOIP') {
    return { type: 'GEOIP', payload: parts[1] || '', policy: unquote(parts[2]) || 'DIRECT' };
  }
  
  if (type === 'RULE-SET') {
    return { type: 'RULE-SET', payload: parts[1] || '', policy: unquote(parts[2]) || 'DIRECT' };
  }
  
  // Generic format: TYPE,payload,policy
  if (parts.length >= 3) {
    return { type, payload: parts[1], policy: unquote(parts[2]) };
  }
  
  // Fallback: TYPE,policy
  return { type, payload: '', policy: unquote(parts[1]) || 'DIRECT' };
}

/**
 * 解析 Surge 规则（支持对象或字符串格式）
 * 用于前端 active-chain.ts
 */
export function parseGatewayRule(rule: unknown): { payload?: string; proxy: string } | null {
  if (typeof rule === 'string') {
    const parsed = parseSurgeRule(rule);
    if (!parsed) return null;
    return {
      payload: parsed.payload,
      proxy: parsed.policy,
    };
  } else if (typeof rule === 'object' && rule !== null) {
    const r = rule as Record<string, unknown>;
    // Validate at runtime so the non-optional `proxy` return type holds.
    if (typeof r.proxy !== 'string' || !r.proxy) return null;
    return {
      payload: typeof r.payload === 'string' ? r.payload : undefined,
      proxy: r.proxy,
    };
  }
  return null;
}

/**
 * 提取 Gateway 基础 URL
 * 将 WebSocket URL 转换为 HTTP URL，移除路径
 */
export function getGatewayBaseUrl(url: string): string {
  return url
    .replace(/^ws:\/\//, 'http://')
    .replace(/^wss:\/\//, 'https://')
    .replace(/\/connections\/?$/, '')
    .replace(/\/$/, '');
}

/**
 * 判断是否为 Agent 被动上报后端
 * 约定：backend.url 以 agent:// 开头
 */
export function isAgentBackendUrl(url: string): boolean {
  return /^agent:\/\//i.test((url || '').trim());
}

/**
 * 后端能力判定的输入。刻意接受「后端记录」而非 url 字符串:
 * M1c(统一后端模型)会用 agent_id 取代 agent:// 判据,届时只需改本函数实现,
 * 签名与调用点保持不变。
 */
export interface BackendCapabilityInput {
  url: string;
  /** M0 兼容形态;M1c 新字段在场时被 agentId 取代 */
  agentBound?: boolean;
  /** M1c:'' = 无 API 通道 */
  apiUrl?: string;
  /** M1c:'' = 未配 agent */
  agentToken?: string;
  /** M1c:'' = 未绑定 */
  agentId?: string;
}

export interface BackendCapabilities {
  /** 恒 true:所有后端都提供监控 */
  monitoring: boolean;
  /** 实时管理(M1)。M1c 之后所有后端都有 API 地址,此项将恒为 true */
  management: boolean;
  /** 配置编辑(M2),需要绑定 agent */
  configEdit: boolean;
}

/**
 * 唯一的后端能力判定函数。web 据此渲染或置灰功能入口。
 *
 * M0 只交付契约:本函数 + 后端列表 API 的 capabilities 字段。
 * 现存的 isAgentBackendUrl 调用点(全仓 25 处)不在 M0 迁移,属 M1c。
 */
export function backendCapabilities(backend: BackendCapabilityInput): BackendCapabilities {
  if (backend.apiUrl !== undefined || backend.agentToken !== undefined || backend.agentId !== undefined) {
    return {
      monitoring: true,
      management: !!(backend.apiUrl || '').trim(),
      configEdit: !!(backend.agentId || '').trim(),
    };
  }
  // M0 契约回退:仅有 url 时沿用旧判据(web 端在 Task 7 之前仍传此形态)
  const legacyAgentUrl = isAgentBackendUrl(backend.url);
  return {
    monitoring: true,
    management: !legacyAgentUrl,
    configEdit: backend.agentBound ?? legacyAgentUrl,
  };
}
