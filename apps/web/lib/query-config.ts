export const QUERY_CONFIG = {
  STALE_TIME: {
    REALTIME: 5000,
    DETAIL: 30000,
    STATIC: 10 * 60 * 1000, // 10 minutes
  },
  GC_TIME: {
    DEFAULT: 5 * 60 * 1000, // 5 minutes
  },
  LIMIT: {
    DEFAULT: 50,
    DETAIL: 5000,
  },
} as const;
