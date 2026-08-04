/**
 * Data Retention Policy for Neko Master
 * 
 * Tiered storage strategy:
 * - Raw data (connection_logs): 7 days for detailed analysis
 * - Hourly aggregates: 30 days for recent trends
 * - Daily aggregates: 90 days for monthly analysis
 * - Domain/IP stats: Permanent (continuously updated)
 */

export interface RetentionConfig {
  // Raw connection logs retention (detailed per-connection data)
  connectionLogsDays: number;
  
  // Hourly stats retention (for traffic trend charts)
  hourlyStatsDays: number;
  
  // Auto-cleanup enabled
  autoCleanup: boolean;
  
  // Cleanup interval (hours)
  cleanupInterval: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  connectionLogsDays: 7,      // Keep 7 days of raw logs
  hourlyStatsDays: 30,        // Keep 30 days of hourly data
  autoCleanup: true,
  cleanupInterval: 24,        // Run cleanup every 24 hours
};
