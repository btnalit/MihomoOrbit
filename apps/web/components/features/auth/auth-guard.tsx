"use client";

import { useEffect, useRef } from "react";
import { useRequireAuth, useAuth } from "@/lib/auth";
import { useQueryClient } from "@tanstack/react-query";
import { authKeys } from "@/lib/auth-queries";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { LoginDialog } from "./login-dialog";

export function AuthGuard() {
  const { showLogin } = useRequireAuth();
  const { login, confirmLogin } = useAuth();
  const queryClient = useQueryClient();
  const t = useTranslations("auth");
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  if (!showLogin) return null;

  return (
    <LoginDialog
      open={true}
      onOpenChange={() => {}}
      onLogin={handleLogin}
    />
  );
}
