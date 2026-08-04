/**
 * Database Module
 * 
 * This module provides database schema definitions and repository classes
 * for performing database operations in a modular and type-safe way.
 */

// Schema definitions
export {
  SCHEMA,
  INDEXES,
  DEFAULT_APP_CONFIG,
  getAllSchemaStatements,
} from './schema.js';

// Repositories
export {
  BaseRepository,
  DomainRepository,
  BackendRepository,
  type BackendConfig,
} from './repositories/index.js';
