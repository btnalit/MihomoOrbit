"use client";

import { useEffect, useRef } from "react";
import { useRequireAuth, useAuth } from "@/lib/auth";
import { useQueryClient } from "@tanstack/react-query";
import { authKeys, useEnableAuth } from "@/lib/auth-queries";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { LoginDialog } from "./login-dialog";

export function AuthGuard() {
  const { showLogin, needsSetup } = useRequireAuth();
  const { login, confirmLogin, confirmSetup } = useAuth();
  const queryClient = useQueryClient();
  const t = useTranslations("auth");
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enableAuth = useEnableAuth();

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const handleLogin = async (token: string): Promise<boolean> => {
    try {
      const success = await login(token, false);
      if (success) {
        // Wait for animation to finish (2.5s matches LoginDialog animation)
        confirmTimerRef.current = setTimeout(() => {
          confirmLogin();
          // Invalidate auth state to trigger re-check
          queryClient.invalidateQueries({ queryKey: authKeys.state() });
        }, 2500);
        return true;
      } else {
        toast.error(t("invalidToken"));
        return false;
      }
    } catch {
      toast.error(t("invalidToken"));
      return false;
    }
  };

  // 首次设置:用启动日志里的 setup token 设定访问令牌,成功后自动登录。
  const handleSetup = async (token: string, setupToken?: string): Promise<boolean> => {
    if (!setupToken) return false;
    try {
      await enableAuth.mutateAsync({ setupToken, token });
      confirmTimerRef.current = setTimeout(() => {
        // confirmSetup() flips authState.configured synchronously so
        // `needsSetup` is already false when this callback returns —
        // see the comment on confirmSetup() in lib/auth.tsx for why a
        // checkAuth()-only refetch (async) isn't reliable here.
        confirmSetup();
        queryClient.invalidateQueries({ queryKey: authKeys.state() });
      }, 2500);
      return true;
    } catch (error) {
      // 把后端的具体原因(setup token 无效 / 令牌不合规)透传给对话框
      throw error instanceof Error ? error : new Error(t("setupFailed"));
    }
  };

  if (needsSetup) {
    return (
      <LoginDialog
        open={true}
        mode="setup"
        onOpenChange={() => {}}
        onLogin={handleSetup}
      />
    );
  }

  if (!showLogin) return null;

  return (
    <LoginDialog
      open={true}
      onOpenChange={() => {}}
      onLogin={handleLogin}
    />
  );
}
