#!/usr/bin/env node
// Generates docs/architecture.excalidraw from the architecture in docs/architecture.md

const fs = require('fs');

let _seed = 1000;
const now = Date.now();

function s() { return _seed++; }

function rect(id, x, y, w, h, bg, strokeColor = "#495057", strokeWidth = 2) {
  return {
    id, type: "rectangle",
    x, y, width: w, height: h,
    angle: 0, strokeColor, backgroundColor: bg,
    fillStyle: "solid", strokeWidth, strokeStyle: "solid",
    roughness: 0, opacity: 100, groupIds: [], frameId: null,
    roundness: { type: 3 }, seed: s(), version: 1, versionNonce: s(),
    isDeleted: false, boundElements: [], updated: now, link: null, locked: false
  };
}

function text(id, x, y, content, fontSize = 13, color = "#212529", align = "left") {
  const lines = content.split('\n');
  const w = Math.max(...lines.map(l => l.length)) * fontSize * 0.56 + 16;
  const h = lines.length * fontSize * 1.55 + 8;
  return {
    id, type: "text",
    x, y, width: w, height: h,
    angle: 0, strokeColor: color, backgroundColor: "transparent",
    fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid",
    roughness: 0, opacity: 100, groupIds: [], frameId: null,
    roundness: null, seed: s(), version: 1, versionNonce: s(),
    isDeleted: false, boundElements: [], updated: now, link: null, locked: false,
    text: content, fontSize, fontFamily: 1,
    textAlign: align, verticalAlign: "top",
    containerId: null, originalText: content,
    lineHeight: 1.55, baseline: fontSize
  };
}

function arrow(id, x1, y1, x2, y2, color = "#868e96", dashed = false) {
  const dx = x2 - x1, dy = y2 - y1;
  return {
    id, type: "arrow",
    x: x1, y: y1, width: Math.abs(dx), height: Math.abs(dy),
    angle: 0, strokeColor: color, backgroundColor: "transparent",
    fillStyle: "solid", strokeWidth: 2,
    strokeStyle: dashed ? "dashed" : "solid",
    roughness: 0, opacity: 100, groupIds: [], frameId: null,
    roundness: { type: 2 }, seed: s(), version: 1, versionNonce: s(),
    isDeleted: false, boundElements: [], updated: now, link: null, locked: false,
    points: [[0, 0], [dx, dy]],
    lastCommittedPoint: null, startBinding: null, endBinding: null,
    startArrowhead: null, endArrowhead: "arrow"
  };
}

function label(id, x, y, content, fontSize = 12, color = "#495057") {
  return text(id, x, y, content, fontSize, color);
}

const elements = [];
const e = (...args) => elements.push(...args);

// ─────────────────────────────────────────────────────────────────
// TITLE
// ─────────────────────────────────────────────────────────────────
e(text("title", 40, -50, "Neko Master 系统架构图", 28, "#212529"));

// ─────────────────────────────────────────────────────────────────
// LAYER 1: FRONTEND  y: 0 → 440
// ─────────────────────────────────────────────────────────────────
const FE_Y = 0, FE_H = 440;
e(rect("fe-layer", 40, FE_Y, 1760, FE_H, "#e7f5ff", "#1971c2", 3));
e(text("fe-title", 60, FE_Y + 8, "🖥  前端展示层 (Frontend)  ·  Next.js 16 App Router", 17, "#1864ab"));

// Next.js inner container
e(rect("fe-nextjs", 70, FE_Y + 38, 1700, 185, "#d0ebff", "#339af0", 2));
e(text("fe-nextjs-t", 90, FE_Y + 46, "Next.js 16 (App Router)", 14, "#1864ab"));

// 4 page cards
const CARDS = [
  ["fe-dash",    90,  FE_Y+72, 390, 138, "Dashboard\n仪表板\n\n主数据看板"],
  ["fe-over",   500,  FE_Y+72, 390, 138, "Overview\n概览\n\n汇总统计"],
  ["fe-charts", 910,  FE_Y+72, 390, 138, "Charts\n图表\n\n趋势可视化"],
  ["fe-tables",1320,  FE_Y+72, 440, 138, "Interactive Tables\n交互式表格\n\n域名/IP/代理/规则"],
];
CARDS.forEach(([id, x, y, w, h, txt]) => {
  e(rect(id + "-r", x, y, w, h, "#ffffff", "#74c0fc", 1));
  e(text(id + "-t", x + 12, y + 10, txt, 12, "#1864ab"));
});

// React Query & WS Hook
e(rect("fe-rq-r",   70, FE_Y+235, 835, 185, "#e7f5ff", "#339af0", 2));
e(text("fe-rq-t",   90, FE_Y+245,
  "React Query (TanStack)\n\n· API 数据获取与缓存\n· 乐观更新与状态管理\n· 自动重试与错误处理",
  13, "#1864ab"));

e(rect("fe-wsh-r", 925, FE_Y+235, 845, 185, "#e7f5ff", "#339af0", 2));
e(text("fe-wsh-t", 945, FE_Y+245,
  "useStatsWebSocket Hook\n\n· WebSocket 连接管理\n· 实时数据订阅\n· 自动重连与心跳",
  13, "#1864ab"));

// ─────────────────────────────────────────────────────────────────
// Arrow  FE → SVC
// ─────────────────────────────────────────────────────────────────
const SVC_Y = 510;
e(arrow("arr-fe-svc", 950, FE_Y + FE_H, 950, SVC_Y, "#1971c2"));
e(label("arr-fe-svc-lbl", 960, FE_Y + FE_H + 8, "HTTP / WebSocket  (Cookie 认证)", 12, "#1971c2"));

// ─────────────────────────────────────────────────────────────────
// LAYER 2: SERVICE  y: 510 → 1700
// ─────────────────────────────────────────────────────────────────
const SVC_H = 1190;
e(rect("svc-layer", 40, SVC_Y, 1760, SVC_H, "#ebfbee", "#2f9e44", 3));
e(text("svc-title", 60, SVC_Y + 8, "⚙️  服务层 (Collector Service)", 17, "#2b8a3e"));

// API Server
e(rect("svc-api-r", 70, SVC_Y + 40, 840, 300, "#d3f9d8", "#51cf66", 2));
e(text("svc-api-t", 90, SVC_Y + 50,
  "API Server (Fastify)\n\nREST API Endpoints:\n  /api/backends     - 后端管理\n  /api/stats        - 统计数据\n  /api/auth         - 认证管理\n  /api/domains      - 域名统计\n  /api/ips          - IP 统计\n  /api/proxies      - 代理统计\n  /api/rules        - 规则统计\n  /api/devices      - 设备统计\n  /api/gateway/*    - 网关代理\n  /api/retention    - 数据保留",
  12, "#1b5e20"));

// WebSocket Server
e(rect("svc-ws-r", 930, SVC_Y + 40, 835, 300, "#d3f9d8", "#51cf66", 2));
e(text("svc-ws-t", 950, SVC_Y + 50,
  "WebSocket Server (ws)\n\n· 连接管理 (Client Connections)\n· 订阅管理 (Range / Backend / Interval)\n· 广播推送 (Broadcast Stats)\n· 摘要缓存 (Summary Cache, 2s TTL)\n· 策略缓存同步 (Surge Policy Sync)\n\n数据包类型:\n  stats  trend  domains  ips  pong",
  12, "#1b5e20"));

// Gateway Collectors container
const GC_Y = SVC_Y + 360;
e(rect("svc-gc-outer", 70, GC_Y, 1700, 310, "#c3fae8", "#20c997", 2));
e(text("svc-gc-title", 90, GC_Y + 8, "Gateway Collectors  (数据采集器)", 14, "#087f5b"));

// Clash Collector ×2  +  Surge Collector
const COL_Y = GC_Y + 38;
const COLS = [
  ["svc-clash1", 90,  COL_Y, 520, 255,
   "Clash Collector (Mihomo)\n\n协议: WebSocket\n  WS /connections  实时推送\n\n功能:\n· 流量追踪 + 增量计算 (delta)\n· 代理链提取 (chains)\n· 批量缓冲 (30s flush / 5000条)\n· GeoIP 查询集成\n· 指数退避重连"],
  ["svc-clash2", 630, COL_Y, 520, 255,
   "Clash Collector (Mihomo)\n\n协议: WebSocket\n  WS /connections  实时推送\n\n功能:\n· 流量追踪 + 增量计算 (delta)\n· 代理链提取 (chains)\n· 批量缓冲 (30s flush / 5000条)\n· GeoIP 查询集成\n· 指数退避重连"],
  ["svc-surge1",1170, COL_Y, 580, 255,
   "Surge Collector\n\n协议: HTTP REST Polling (2s)\n  GET /v1/requests/recent\n\n功能:\n· 防重复计算 (recentlyCompleted Map)\n· 策略缓存同步 (10min 定时)\n· 增量计算 + 批量缓冲 (30s)\n· GeoIP 查询集成\n· 指数退避重试 (≤5次)"],
];
COLS.forEach(([id, x, y, w, h, txt]) => {
  e(rect(id + "-r", x, y, w, h, "#ffffff", "#63e6be", 1));
  e(text(id + "-t", x + 12, y + 10, txt, 11, "#087f5b"));
});

// Policy Sync + RealtimeStore
const PS_Y = SVC_Y + 700;
e(rect("svc-ps-r",  70, PS_Y, 840, 170, "#d3f9d8", "#51cf66", 2));
e(text("svc-ps-t",  90, PS_Y + 10,
  "Policy Sync Service  (背景任务)\n\n· 定时同步 Surge 策略: /v1/policies\n            /v1/policy_groups/select\n· 存储: surge_policy_cache 表\n· 缓存过期: 10 分钟 | 回退: 直接 API",
  12, "#1b5e20"));

e(rect("svc-rt-r", 930, PS_Y, 835, 170, "#d3f9d8", "#51cf66", 2));
e(text("svc-rt-t", 950, PS_Y + 10,
  "RealtimeStore  (内存实时数据, 按 backendId 隔离)\n\n· summaryByBackend  · minuteByBackend\n· domainByBackend   · ipByBackend\n· proxyByBackend    · ruleByBackend\n· countryByBackend  · deviceByBackend\n\nmerge*() 合并 DB 数据与实时增量",
  12, "#1b5e20"));

// GeoIP Service
const GEO_Y = SVC_Y + 900;
e(rect("svc-geo-r", 70, GEO_Y, 1700, 160, "#d3f9d8", "#51cf66", 2));
e(text("svc-geo-t", 90, GEO_Y + 10,
  "GeoIP Service\n\nProviders: IP-API.com (默认)  |  IPInfo.io (备选)\n功能:    本地 LRU 缓存  ·  批量查询优化  ·  失败冷却机制  ·  IPv4/IPv6 双栈  ·  ASN 查询",
  12, "#1b5e20"));

// BatchBuffer (triple write hint)
const BB_Y = SVC_Y + 1095;
e(rect("svc-bb-r", 70, BB_Y, 1700, 80, "#d3f9d8", "#51cf66", 2));
e(text("svc-bb-t", 90, BB_Y + 12,
  "BatchBuffer.flush()  ·  三写模式 (Triple Write):\n    ① SQLite  (始终写入)     ② ClickHouse Buffer 表  (CH_WRITE_ENABLED=1)     ③ RealtimeStore  (内存实时)",
  12, "#1b5e20"));

// ─────────────────────────────────────────────────────────────────
// Arrows  SVC → Storage
// ─────────────────────────────────────────────────────────────────
const ST_Y = SVC_Y + SVC_H + 20;
e(arrow("arr-svc-sq",  480, SVC_Y + SVC_H,  480, ST_Y, "#f08c00"));
e(arrow("arr-svc-ch", 1400, SVC_Y + SVC_H, 1400, ST_Y, "#f08c00", true));
e(label("arr-svc-sq-lbl",  490, SVC_Y + SVC_H + 4, "SQLite (始终写入)", 11, "#e67700"));
e(label("arr-svc-ch-lbl", 1220, SVC_Y + SVC_H + 4, "ClickHouse (CH_WRITE_ENABLED=1, 可选)", 11, "#e67700"));

// ─────────────────────────────────────────────────────────────────
// LAYER 3: STORAGE  y: ST_Y → ST_Y+500
// ─────────────────────────────────────────────────────────────────
const ST_H = 480;
e(rect("st-layer", 40, ST_Y, 1760, ST_H, "#fff9db", "#f59f00", 3));
e(text("st-title", 60, ST_Y + 8, "💾  数据存储层 (Storage)", 17, "#e67700"));

// SQLite
e(rect("st-sq-r", 70, ST_Y + 42, 840, 415, "#fff3bf", "#fcc419", 2));
e(text("st-sq-t", 90, ST_Y + 52,
  "SQLite Database  (WAL Mode)  [始终启用]\n\n统计表  (按 backend_id 分区):\n  domain_stats    ip_stats         proxy_stats\n  rule_stats      country_stats    device_stats\n  minute_stats    hourly_stats     daily_stats\n\n配置 / 缓存表:\n  backend_configs   geoip_cache   asn_cache\n  auth_config       retention_config\n  surge_policy_cache\n\nRepository 模式 (12 个 Repo 类):\n  domain · ip · rule · proxy · device\n  country · timeseries · config · backend\n  auth · surge · trafficWriter",
  12, "#7d5807"));

// ClickHouse
e(rect("st-ch-r", 930, ST_Y + 42, 835, 415, "#fff3bf", "#fcc419", 2));
e(text("st-ch-t", 950, ST_Y + 52,
  "ClickHouse  [可选, CH_ENABLED=1]\n\nBuffer 表 (异步接收, ~5min 合并):\n  traffic_detail_buffer\n  traffic_agg_buffer\n  country_buffer\n         ↓  merge  (SummingMergeTree)\n主数据表:\n  traffic_detail   (连接详情)\n  traffic_agg      (聚合统计)\n  country_stats    (国家统计)\n\n读取路由 (STATS_QUERY_SOURCE):\n  sqlite     → 全部读 SQLite  (默认)\n  clickhouse → 全部读 ClickHouse\n  auto       → 智能路由",
  12, "#7d5807"));

// ─────────────────────────────────────────────────────────────────
// Arrow  DS → SVC  (upward, left side)
// ─────────────────────────────────────────────────────────────────
const DS_Y = ST_Y + ST_H + 20;
e(arrow("arr-ds-svc", 100, DS_Y, 100, SVC_Y + SVC_H, "#9c36b5"));
e(label("arr-ds-lbl", 112, DS_Y - 120, "数据采集\nWebSocket\n/ HTTP Poll", 11, "#9c36b5"));

// ─────────────────────────────────────────────────────────────────
// LAYER 4: DATA SOURCES  y: DS_Y → DS_Y+360
// ─────────────────────────────────────────────────────────────────
const DS_H = 360;
e(rect("ds-layer", 40, DS_Y, 1760, DS_H, "#f3d9fa", "#9c36b5", 3));
e(text("ds-title", 60, DS_Y + 8, "📡  数据源层 (Data Sources / Gateways)", 17, "#862e9c"));

// Clash/Mihomo
e(rect("ds-clash-r", 70, DS_Y + 42, 840, 295, "#eedefa", "#cc5de8", 2));
e(text("ds-clash-t", 90, DS_Y + 52,
  "Clash / Mihomo Gateway\n\nWebSocket 端点:\n  WS /connections  (实时推送, 每连接更新)\n  WS /traffic\n  HTTP /rules  /proxies\n\n连接数据格式:\n  { connections: [{\n    id: \"uuid\",\n    metadata: {\n      host, destinationIP, sourceIP,\n      chains: [...],  rule, rulePayload,\n      upload, download  }}]}",
  12, "#862e9c"));

// Surge
e(rect("ds-surge-r", 930, DS_Y + 42, 835, 295, "#eedefa", "#cc5de8", 2));
e(text("ds-surge-t", 950, DS_Y + 52,
  "Surge Gateway (v5+)\n\nHTTP REST API 端点:\n  GET /v1/requests/recent  (最近连接, 2s 轮询)\n  GET /v1/policies         (策略列表)\n  GET /v1/policy_groups/select  (策略组)\n\n开启方式:\n  http-api = 127.0.0.1:9091\n  http-api-tls = false\n\n注意: DNS 在代理服务器解析\n      无法获取真实落地 IP",
  12, "#862e9c"));

// ─────────────────────────────────────────────────────────────────
// AGENT MODE SECTION  (below main arch)
// ─────────────────────────────────────────────────────────────────
const AG_Y = DS_Y + DS_H + 80;

e(text("ag-section-title", 40, AG_Y - 38, "── Agent 模式架构 (远程数据采集) ──────────────────────────────────────────────────────────────────", 16, "#495057"));

// Central Panel
e(rect("ag-panel-r", 600, AG_Y, 700, 380, "#e7f5ff", "#1971c2", 2));
e(text("ag-panel-t", 620, AG_Y + 10,
  "中心面板 (Neko Master)\n\nFastify API Server:\n  POST /api/agent/report\n       接收批量流量增量\n  POST /api/agent/heartbeat\n       接收心跳 (在线状态)\n  POST /api/agent/config-sync\n       规则/代理/Provider 配置\n  POST /api/agent/policy-state\n       当前策略状态\n\nBackend 类型: agent://\n系统生成 token, 绑定 agentId",
  12, "#1864ab"));

// Arrow: Agent → Panel
const AG_HOST_Y = AG_Y + 450;
e(arrow("ag-arr-up", 950, AG_HOST_Y, 950, AG_Y + 380, "#868e96"));
e(label("ag-arr-lbl", 960, AG_HOST_Y - 50, "HTTP  (token 鉴权)", 11, "#868e96"));

// Remote Host
e(rect("ag-host-r", 300, AG_HOST_Y, 1300, 500, "#ebfbee", "#2f9e44", 2));
e(text("ag-host-t", 320, AG_HOST_Y + 10,
  "网关旁边的主机 (Remote Host)\n\norbitagent  (CLI 管理器, Shell 脚本)\n  /etc/orbit-agent/<instance>.env     配置文件\n  /var/run/orbit-agent/<instance>.pid  PID 文件\n\norbit-agent  (守护进程, Go)\n  1. 拉取网关数据\n       Clash/Mihomo: WS /connections (实时推送)\n       Surge:        HTTP GET /v1/requests/recent (2s 轮询)\n  2. 增量计算 (Delta)\n       识别新/更新连接 → 计算 upload/download 增量 → 聚合\n  3. 批量上报 (每 2s)  POST /api/agent/report\n       最多 1000 条/批, 积压上限 50000 条\n  4. 心跳 (每 30s)  POST /api/agent/heartbeat\n  5. 配置同步 (每 2min, MD5 去重)  POST /api/agent/config-sync\n  6. 策略同步 (每 30s, 变化时)  POST /api/agent/policy-state\n\nPID 锁: 同一 backendId 同时只允许一个进程运行",
  12, "#1b5e20"));

// Gateway below agent host
const AG_GW_Y = AG_HOST_Y + 570;
e(arrow("ag-arr-gw", 950, AG_GW_Y, 950, AG_HOST_Y + 500, "#868e96"));
e(label("ag-gw-lbl", 960, AG_HOST_Y + 510, "本地网络 (LAN)", 11, "#868e96"));

e(rect("ag-gw-r", 600, AG_GW_Y, 700, 100, "#f3d9fa", "#9c36b5", 2));
e(text("ag-gw-t", 620, AG_GW_Y + 20, "Clash/Mihomo  或  Surge  Gateway API", 14, "#862e9c"));

// ─────────────────────────────────────────────────────────────────
// OUTPUT
// ─────────────────────────────────────────────────────────────────
const diagram = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements,
  appState: {
    gridSize: null,
    viewBackgroundColor: "#f8f9fa"
  },
  files: {}
};

const outPath = 'docs/architecture.excalidraw';
fs.writeFileSync(outPath, JSON.stringify(diagram, null, 2), 'utf-8');
console.log(`✅  Generated ${outPath}  (${elements.length} elements)`);
