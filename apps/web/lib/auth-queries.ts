"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { AuthState } from "@mihomo-orbit/shared";

// API functions
async function fetchAuthState(): Promise<AuthState> {
  const response = await fetch("/api/auth/state");
  if (!response.ok) {
    throw new Error("Failed to fetch auth state");
  }
  return response.json();
}

async function verifyToken(token: string): Promise<boolean> {
  // Just send the token in body, server will set cookie
  const response = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    return false;
  }
  const result = await response.json();
  return result.valid;
}

/**
 * 首次设置:未配置状态下 /api/auth/enable 要求携带一次性 setup token,
 * 该 token 打印在 collector 启动日志里。见设计规范 3.5(b)。
 */
async function enableAuth(setupToken: string, token: string): Promise<void> {
  const response = await fetch("/api/auth/enable", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Setup-Token": setupToken },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error || "Failed to complete setup");
  }
}

// Query keys
export const authKeys = {
  all: ["auth"] as const,
  state: () => [...authKeys.all, "state"] as const,
};

// React Query hooks
export function useAuthState() {
  return useQuery({
    queryKey: authKeys.state(),
    queryFn: fetchAuthState,
    // Don't set initialData - let it load from server
    // If error occurs, we need to know about it
    retry: (failureCount, error) => {
      // Don't retry on 401/403
      if ((error as any)?.status === 401 || (error as any)?.message?.includes('401')) return false;
      return failureCount < 3;
    },
    // Refetch on window focus to keep auth state in sync
    refetchOnWindowFocus: true,
    // Refetch when reconnecting
    refetchOnReconnect: true,
    // Stale time - consider data fresh for 5 minutes
    staleTime: 5 * 60 * 1000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (token: string) => {
      const isValid = await verifyToken(token);
      if (!isValid) {
        throw new Error("Invalid token");
      }
      return true;
    },
    onSuccess: () => {
      // Invalidate auth state to trigger a refetch
      queryClient.invalidateQueries({ queryKey: authKeys.state() });
    },
  });
}

export function useEnableAuth() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ setupToken, token }: { setupToken: string; token: string }) => {
      await enableAuth(setupToken, token);
      // 设置成功后立即登录,拿到 orbit-session cookie
      const isValid = await verifyToken(token);
      if (!isValid) {
        throw new Error("Setup succeeded but login failed");
      }
      return true;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: authKeys.state() });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      await fetch("/api/auth/logout", { method: "POST" });
    },
    onSuccess: () => {
      // Invalidate and refetch auth state
      queryClient.invalidateQueries({ queryKey: authKeys.state() });
      // Force reload to ensure clean state
      window.location.reload();
    },
  });
}

// Helper function to get auth headers for API requests
// Cookies are handled automatically by browser
export function getAuthHeaders(): Record<string, string> {
  return {};
}
