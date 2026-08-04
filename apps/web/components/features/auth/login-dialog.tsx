"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Lock, Eye, EyeOff, AlertCircle, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const CAT_OPEN_EYE = "/images/neko-open-eye.png";
const CAT_CLOSE_EYE = "/images/neko-open-close.png";
const NEKO_WELCOME = "/images/neko-welcome.png";

interface LoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLogin: (token: string) => Promise<boolean>;
}

export function LoginDialog({ open, onOpenChange, onLogin }: LoginDialogProps) {
  const t = useTranslations("auth");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!token.trim()) {
      setError(t("tokenRequired"));
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const success = await onLogin(token);
      if (success) {
        setIsSuccess(true);
        // Wait for animation
        setTimeout(() => {
          setToken("");
          setIsSuccess(false);
          onOpenChange(false);
        }, 2500);
      } else {
        setError(t("invalidToken"));
        setIsLoading(false);
      }
    } catch (err) {
      setError(t("loginError"));
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent 
        className="sm:max-w-md overflow-visible bg-transparent shadow-none border-none p-0"
        showCloseButton={!isSuccess}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => e.preventDefault()}
        overlayClassName={cn(
          isSuccess && "delay-[500ms] duration-[2000ms] ease-linear backdrop-blur-none bg-transparent"
        )}
      >
        <AnimatePresence mode="wait">
          {isSuccess ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="flex flex-col items-center justify-center py-10 px-6 sm:py-14 sm:px-10 space-y-6 bg-background border shadow-lg rounded-xl w-[90vw] max-w-sm sm:w-auto sm:max-w-none sm:min-w-[28rem]"
            >
              <div className="relative w-40 h-40 sm:w-50 sm:h-50">
                 <Image
                  src={NEKO_WELCOME}
                  alt="Welcome Neko"
                  fill
                  className="object-contain drop-shadow-xl"
                  priority
                />
              </div>
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.5 }}
                className="text-center"
              >
                <div className="flex items-center justify-center gap-2">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 200, damping: 10, delay: 0.1 }}
                    className="w-6 h-6 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-500 shadow-sm"
                  >
                    <Check className="w-3.5 h-3.5 stroke-[3]" />
                  </motion.div>
                  <h3 className="text-xl sm:text-2xl font-semibold text-foreground tracking-tight">
                    {t("loginSuccess") || "Welcome back"}
                  </h3>
                </div>
                <p className="text-sm text-muted-foreground/75 mt-2 font-medium">
                  {t("redirecting") || "Syncing network statistics..."}
                </p>
                <div className="w-full max-w-[12rem] sm:max-w-none sm:w-64 h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full mt-5 overflow-hidden relative mx-auto">
                    <motion.div 
                        initial={{ width: "0%" }}
                        animate={{ width: "100%" }}
                        transition={{ duration: 2.5, ease: "easeInOut" }}
                        className="absolute left-0 top-0 h-full bg-gradient-to-r from-[#181878] via-[#668af4] to-[#181878] animate-gradient-x"
                        style={{ backgroundSize: "200% 100%" }}
                    />
                </div>
              </motion.div>
            </motion.div>
          ) : (
            <motion.div
              key="form"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="relative"
            >
              {/* Cat Animation - Behind the card */}
              <div className="absolute -top-28 left-1/2 -translate-x-1/2 z-0 pointer-events-none">
                <div className="relative w-40 h-32 transition-transform duration-300 ease-in-out hover:scale-105">
                     {/* Closed Eye Cat (Always present as base) */}
                    <div className="absolute inset-0">
                      <Image
                        src={CAT_CLOSE_EYE}
                        alt="Cat Closed Eyes"
                        fill
                        className="object-contain drop-shadow-2xl filter brightness-110"
                        priority
                      />
                    </div>

                    {/* Open Eye Cat (Overlay that fades out) */}
                    <motion.div
                      className="absolute inset-0"
                      initial={{ opacity: 1 }}
                      animate={{ opacity: isFocused ? 0 : 1 }}
                      transition={{ duration: 0.2 }}
                    >
                      <Image
                        src={CAT_OPEN_EYE}
                        alt="Cat Open Eyes"
                        fill
                        className="object-contain drop-shadow-2xl filter brightness-110"
                        priority
                      />
                    </motion.div>
                </div>
              </div>

              {/* Card Content - In front of the cat */}
              <div className="relative z-10 bg-background border shadow-lg rounded-lg p-6 pt-10 dark:bg-[#1a1a2e] dark:border-white/15 dark:shadow-[0_0_60px_-4px_rgba(100,130,255,0.12)]">
                <DialogTitle className="sr-only">
                  {t("loginTitle")}
                </DialogTitle>

              <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                <div className="space-y-2">
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      type={showToken ? "text" : "password"}
                      placeholder={t("tokenPlaceholder")}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      onFocus={() => setIsFocused(true)}
                      onBlur={() => setIsFocused(false)}
                      className={cn(
                        "pl-10 pr-10 dark:border-white/20",
                        error && "border-destructive focus-visible:ring-destructive"
                      )}
                      disabled={isLoading}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      tabIndex={-1}
                    >
                      {showToken ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>

                  {error && (
                    <div className="flex items-center gap-2 text-sm text-destructive">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      <span>{error}</span>
                    </div>
                  )}
                </div>

                <Button
                  type="submit"
                  className="w-full relative overflow-hidden bg-gradient-to-r from-[#181878] via-[#668af4] to-[#181878] hover:opacity-90 transition-all border-none animate-gradient-x disabled:opacity-100"
                  disabled={isLoading || !token.trim()}
                >
                  <AnimatePresence mode="wait">
                    {isLoading ? (
                      <motion.div
                        key="loading"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="flex items-center gap-2"
                      >
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {t("loggingIn")}
                      </motion.div>
                    ) : (
                      <motion.span
                        key="label"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                      >
                        {t("login")}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </Button>
              </form>

              </div>
            </motion.div>

          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
