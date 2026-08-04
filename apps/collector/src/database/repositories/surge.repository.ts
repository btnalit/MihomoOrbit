/**
 * Surge Repository
 *
 * Handles Surge policy cache storage and retrieval.
 */
import type Database from 'better-sqlite3';
import { BaseRepository } from './base.repository.js';

export class SurgeRepository extends BaseRepository {
  constructor(db: Database.Database) {
    super(db);
  }

  getSurgePolicyCache(backendId: number): Array<{
    policyGroup: string;
    selectedPolicy: string | null;
    policyType: string;
    allPolicies: string[] | null;
    updatedAt: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT policy_group as policyGroup,
             selected_policy as selectedPolicy,
             policy_type as policyType,
             all_policies as allPolicies,
             updated_at as updatedAt
      FROM surge_policy_cache
      WHERE backend_id = ?
      ORDER BY policy_group
    `);
    const rows = stmt.all(backendId) as any[];
    return rows.map(r => ({
      ...r,
      allPolicies: r.allPolicies ? JSON.parse(r.allPolicies) : null,
    }));
  }

  updateSurgePolicyCache(
    backendId: number,
    policies: Array<{
      policyGroup: string;
      selectedPolicy: string | null;
      policyType?: string;
      allPolicies?: string[];
    }>,
  ): void {
    const insert = this.db.prepare(`
      INSERT INTO surge_policy_cache
        (backend_id, policy_group, selected_policy, policy_type, all_policies, updated_at)
      VALUES
        (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(backend_id, policy_group) DO UPDATE SET
        selected_policy = excluded.selected_policy,
        policy_type = excluded.policy_type,
        all_policies = excluded.all_policies,
        updated_at = excluded.updated_at
    `);

    const transaction = this.db.transaction((items: typeof policies) => {
      for (const item of items) {
        insert.run(
          backendId,
          item.policyGroup,
          item.selectedPolicy,
          item.policyType || 'Select',
          item.allPolicies ? JSON.stringify(item.allPolicies) : null,
        );
      }
    });

    transaction(policies);
  }

  getSurgePolicyCacheLastUpdate(backendId: number): string | null {
    const stmt = this.db.prepare(`SELECT MAX(updated_at) as lastUpdate FROM surge_policy_cache WHERE backend_id = ?`);
    const row = stmt.get(backendId) as any;
    return row?.lastUpdate || null;
  }

  clearSurgePolicyCache(backendId: number): void {
    this.db.prepare(`DELETE FROM surge_policy_cache WHERE backend_id = ?`).run(backendId);
  }
}
