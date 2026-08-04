/**
 * Auth Module Type Definitions
 */

export interface AuthConfig {
  enabled: boolean;
  tokenHash: string | null;
  updatedAt: string;
}

export interface AuthVerifyResult {
  valid: boolean;
  message?: string;
}

export interface AuthState {
  enabled: boolean;
  hasToken: boolean;
  forceAccessControlOff?: boolean;
  showcaseMode?: boolean;
}
