"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { authKeys } from "./auth-queries";

import type { AuthState } from "@mihomo-orbit/shared";

interface AuthContextType {
  isAuthenticated: boolean;
  authState: AuthState | null;
  isLoading: boolean;
  login: (token: string, updateState?: boolean) => Promise<boolean>;
  confirmLogin: () => void;
  confirmSetup: () => void;
  logout: () => void;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();
  // We use useLogout logic but inside provider
  const { mutate: logoutMutate } = useMutation({
    mutationFn: async () => {
       await fetch("/api/auth/logout", { method: "POST" });
    },
    onSuccess: () => {
      setIsAuthenticated(false);
      window.location.reload();
    }
  });

  // Check auth state from server
  const checkAuth = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/state");
      
      // If we can't reach the server, assume no auth required/error
      // But actually if we are authorized, we should be able to reach it.
      // Wait, /api/auth/state is public.
      
      if (!response.ok) {
        // configured 取 true:这是「拿不到状态」的乐观兜底,若填 false,
        // 一次网络抖动就会弹出首次设置对话框。服务端仍然强制认证。
        setAuthState({ enabled: false, hasToken: false, configured: true });
        setIsAuthenticated(true);
        return;
      }

      const state: AuthState = await response.json();
      setAuthState(state);

      if (!state.enabled) {
        // Auth is not enabled, user is automatically authenticated
        setIsAuthenticated(true);
        return;
      }

      // Auth is enabled – check if we have a valid session by hitting a
      // protected, lightweight endpoint.  `/api/backends` is a core endpoint
      // that will always exist and is protected by the auth middleware.
      const checkRes = await fetch("/api/backends");
      if (checkRes.ok) {
        setIsAuthenticated(true);
      } else {
        setIsAuthenticated(false);
      }

    } catch (error) {
      console.error("Failed to check auth state:", error);
      // On error, assume no auth required to prevent lockout
      // configured 取 true:这是「拿不到状态」的乐观兜底,若填 false,
      // 一次网络抖动就会弹出首次设置对话框。服务端仍然强制认证。
      setAuthState({ enabled: false, hasToken: false, configured: true });
      setIsAuthenticated(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Confirm login manually (used for delayed UI transitions)
  const confirmLogin = useCallback(() => {
    setIsAuthenticated(true);
  }, []);

  // Confirm first-run setup manually (mirrors confirmLogin). Called from the
  // setup dialog's success-animation timer in AuthGuard.
  //
  // A plain checkAuth() refetch is not enough here: it's async, and would
  // race LoginDialog's own ~2500ms success timer (started ~simultaneously).
  // If the network round trip doesn't land before that timer fires,
  // LoginDialog resets to a blank form before the dialog is unmounted —
  // review finding C2. Flipping authState synchronously guarantees
  // `needsSetup` is already false by the time that happens.
  const confirmSetup = useCallback(() => {
    setAuthState((prev) =>
      prev ? { ...prev, enabled: true, hasToken: true, configured: true } : prev
    );
    setIsAuthenticated(true);
  }, []);

  // Login with token
  const login = useCallback(
    async (token: string, updateState = true): Promise<boolean> => {
      try {
        const response = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });

        if (!response.ok) {
          return false;
        }

        const result = await response.json();
        if (result.valid) {
          if (updateState) {
            setIsAuthenticated(true);
          }
          return true;
        }

        return false;
      } catch (error) {
        console.error("Login failed:", error);
        return false;
      }
    },
    []
  );

  // Logout
  const logout = useCallback(() => {
    logoutMutate();
  }, [logoutMutate]);

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Listen for unauthorized events from API (from custom fetch wrapper or axios)
  useEffect(() => {
    const handleUnauthorized = () => {
      setIsAuthenticated(false);
    };

    window.addEventListener("api:unauthorized", handleUnauthorized);
    return () => {
      window.removeEventListener("api:unauthorized", handleUnauthorized);
    };
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        authState,
        isLoading,
        login,
        confirmLogin,
        confirmSetup,
        logout,
        checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

// Hook to determine if login dialog should be shown
export function useRequireAuth() {
  const { authState, isAuthenticated, isLoading } = useAuth();
  
  // Logic: 
  // 1. If loading, don't show login yet (or show loading spinner)
  // 2. If auth not enabled, don't show login
  // 3. If auth enabled and not authenticated, show login
  
  // 首次设置:认证尚未配置(或旧 sha256 哈希被判为未配置)。
  // 此时后端除 /api/auth/{state,enable} 外一律 401,WS 也会拒连,
  // 必须渲染设置流而不是登录框,否则页面空白且不断重连。
  const needsSetup =
    !isLoading && !!authState && !authState.configured && !authState.forceAccessControlOff;

  // 已配置才谈得上登录
  const showLogin =
    !isLoading && !!authState?.enabled && !!authState?.configured && !isAuthenticated;

  return {
    showLogin,
    needsSetup,
    isLoading,
    authEnabled: authState?.enabled,
    error: null, // We handle errors via event listeners mostly
  };
}
