import type Database from 'better-sqlite3';

/**
 * M1c 统一后端模型迁移(幂等):
 * - backend_configs 增 4 列(api_url / api_secret / agent_token / agent_id)——仅当列不存在时 ALTER TABLE
 * - agent:// 行:token -> agent_token;现役心跳的 agent_id 固化为显式绑定
 * - 直连行:url -> api_url,token -> api_secret
 * - url/token 保留原值作回滚镜像,此后 collector 只写不读
 *
 * 回填 UPDATE 每次启动都会执行,但按行幂等(WHERE 条件带 api_url = '' AND agent_token = ''),
 * 这样列已存在、但行还没被拆分的"迟到"记录(如老库升级时 performMigration 借助列默认值插入的
 * Default 直连后端,或 Task 2 CRUD 改造前经旧接口创建的行)仍会被覆盖;已拆分的行 api_url 或
 * agent_token 非空,WHERE 不再命中,重复执行是 no-op。解绑(unbindAgent)只清 agent_id、保留
 * agent_token,所以 agent 分支的 WHERE 不会在下次启动时把已解绑的行重新认领。
 */
export function migrateBackendConfigsToUnifiedModel(db: Database.Database): void {
  const columns = (db.prepare(`PRAGMA table_info(backend_configs)`).all() as { name: string }[])
    .map((c) => c.name);
  const hasNewColumns = columns.includes('api_url');

  const migrate = db.transaction(() => {
    if (!hasNewColumns) {
      db.exec(`ALTER TABLE backend_configs ADD COLUMN api_url TEXT DEFAULT ''`);
      db.exec(`ALTER TABLE backend_configs ADD COLUMN api_secret TEXT DEFAULT ''`);
      db.exec(`ALTER TABLE backend_configs ADD COLUMN agent_token TEXT DEFAULT ''`);
      db.exec(`ALTER TABLE backend_configs ADD COLUMN agent_id TEXT DEFAULT ''`);
    }

    // SQLite 的 LIKE 对 ASCII 不区分大小写,与 isAgentBackendUrl 的 /i 正则一致
    const agentResult = db.prepare(`
      UPDATE backend_configs SET
        agent_token = token,
        agent_id = COALESCE(
          (SELECT h.agent_id FROM agent_heartbeats h WHERE h.backend_id = backend_configs.id), '')
      WHERE TRIM(url) LIKE 'agent://%' AND agent_token = '' AND api_url = ''
    `).run();

    const directResult = db.prepare(`
      UPDATE backend_configs SET api_url = url, api_secret = token
      WHERE TRIM(url) NOT LIKE 'agent://%' AND api_url = '' AND agent_token = ''
    `).run();

    return agentResult.changes + directResult.changes;
  });

  const backfilledRows = migrate();
  if (backfilledRows > 0) {
    console.info(`[DB] Migration: backend_configs unified model backfilled ${backfilledRows} row(s) (api_url/api_secret/agent_token/agent_id)`);
  }
}
