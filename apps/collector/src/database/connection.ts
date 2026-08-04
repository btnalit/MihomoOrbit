import Database from 'better-sqlite3';
import path from 'path';

export interface DatabaseConfig {
  dbPath: string;
  enableWAL?: boolean;
  cacheSize?: number;      // in KB, negative for pages
  busyTimeout?: number;    // in milliseconds
}

const DEFAULT_CONFIG: Partial<DatabaseConfig> = {
  enableWAL: true,
  cacheSize: -16000,       // 16MB page cache
  busyTimeout: 5000,
};

export function createDatabase(config: DatabaseConfig): Database.Database {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const resolvedPath = path.resolve(finalConfig.dbPath);
  
  const db = new Database(resolvedPath);
  
  // Enable WAL mode for better concurrency
  if (finalConfig.enableWAL) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('wal_autocheckpoint = 1000');
  }
  
  // Performance settings
  db.pragma('temp_store = MEMORY');
  db.pragma(`cache_size = ${finalConfig.cacheSize}`);
  db.pragma(`busy_timeout = ${finalConfig.busyTimeout}`);
  
  return db;
}

export function closeDatabase(db: Database.Database): void {
  if (db) {
    db.close();
  }
}
