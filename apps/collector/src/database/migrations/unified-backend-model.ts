import type Database from 'better-sqlite3';

/**
 * M1c 统一后端模型迁移(幂等):
 * - backend_configs 增 4 列(api_url / api_secret / agent_token / agent_id)
 * - agent:// 行:token -> agent_token;现役心跳的 agent_id 固化为显式绑定
 * - 直连行:url -> api_url,token -> api_secret
 * - url/token 保留原值作回滚镜像,此后 collector 只写不读
 */
export function migrateBackendConfigsToUnifiedModel(db: Database.Database): void {
  const columns = (db.prepare(`PRAGMA table_info(backend_configs)`).all() as { name: string }[])
    .map((c) => c.name);
  if (columns.includes('api_url')) {
    return; // 已迁移
  }

  const migrate = db.transaction(() => {
    db.exec(`ALTER TABLE backend_configs ADD COLUMN api_url TEXT DEFAULT ''`);
    db.exec(`ALTER TABLE backend_configs ADD COLUMN api_secret TEXT DEFAULT ''`);
    db.exec(`ALTER TABLE backend_configs ADD COLUMN agent_token TEXT DEFAULT ''`);
    db.exec(`ALTER TABLE backend_configs ADD COLUMN agent_id TEXT DEFAULT ''`);

    // SQLite 的 LIKE 对 ASCII 不区分大小写,与 isAgentBackendUrl 的 /i 正则一致
    db.exec(`
      UPDATE backend_configs SET
        agent_token = token,
        agent_id = COALESCE(
          (SELECT h.agent_id FROM agent_heartbeats h WHERE h.backend_id = backend_configs.id), '')
      WHERE TRIM(url) LIKE 'agent://%';
    `);
    db.exec(`
      UPDATE backend_configs SET api_url = url, api_secret = token
      WHERE TRIM(url) NOT LIKE 'agent://%';
    `);
  });
  migrate();
  console.info('[DB] Migration: backend_configs unified model (api_url/api_secret/agent_token/agent_id)');
}
