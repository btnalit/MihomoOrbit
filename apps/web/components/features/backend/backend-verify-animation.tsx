"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, X, Shield, Server, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type VerifyPhase = "pending" | "success" | "error";

interface BackendVerifyAnimationProps {
  show: boolean;
  phase: VerifyPhase;
  onComplete?: () => void;
  backendName?: string;
  message?: string;
}

export function BackendVerifyAnimation({
  show,
  phase,
  onComplete,
  backendName,
  message,
}: BackendVerifyAnimationProps) {
  const [displayPhase, setDisplayPhase] = useState<VerifyPhase>("pending");

  useEffect(() => {
    if (!show) {
      setDisplayPhase("pending");
      return;
    }

    setDisplayPhase(phase);

    // Auto-complete after showing result
    if (phase === "success" || phase === "error") {
      const timer = setTimeout(() => {
        onComplete?.();
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [show, phase, onComplete]);

  if (!show) return null;

  const isPending = displayPhase === "pending";
  const isSuccess = displayPhase === "success";
  const isError = displayPhase === "error";

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-background/60 backdrop-blur-sm"
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="relative flex flex-col items-center gap-5 p-8 rounded-3xl glass-card max-w-sm mx-4 w-full"
        >
          {/* Animated Icon Container */}
          <div className="relative w-24 h-24 flex items-center justify-center">
            {/* Background pulse rings for pending state */}
            {isPending && (
              <>
                <motion.div
                  className="absolute inset-0 rounded-full bg-primary/10"
                  animate={{
                    scale: [1, 1.2, 1],
                    opacity: [0.5, 0, 0.5],
                  }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                />
                <motion.div
                  className="absolute inset-2 rounded-full bg-primary/20"
                  animate={{
                    scale: [1, 1.1, 1],
                    opacity: [0.6, 0.3, 0.6],
                  }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut", delay: 0.2 }}
                />
              </>
            )}

            {/* Success/Error ring animation */}
            {(isSuccess || isError) && (
              <motion.div
                className={cn(
                  "absolute inset-0 rounded-full",
                  isSuccess ? "bg-green-500/20" : "bg-red-500/20"
                )}
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1.5, opacity: 0 }}
                transition={{ duration: 0.6, ease: "easeOut" }}
              />
            )}

            {/* Main icon */}
            <motion.div
              className={cn(
                "relative z-10 w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg",
                isPending && "bg-gradient-to-br from-primary to-primary/80 shadow-primary/25",
                isSuccess && "bg-gradient-to-br from-green-500 to-green-600 shadow-green-500/25",
                isError && "bg-gradient-to-br from-red-500 to-red-600 shadow-red-500/25"
              )}
              animate={{
                scale: isSuccess || isError ? [1, 1.1, 1] : 1,
              }}
              transition={{ duration: 0.3 }}
            >
              <AnimatePresence mode="wait">
                {isPending && (
                  <motion.div
                    key="pending"
                    initial={{ opacity: 0, rotate: -90 }}
                    animate={{ opacity: 1, rotate: 0 }}
                    exit={{ opacity: 0, rotate: 90 }}
                    transition={{ duration: 0.2 }}
                  >
                    <Loader2 className="w-8 h-8 text-white animate-spin" />
                  </motion.div>
                )}
                {isSuccess && (
                  <motion.div
                    key="success"
                    initial={{ opacity: 0, scale: 0, rotate: -180 }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    transition={{ 
                      type: "spring",
                      stiffness: 200,
                      damping: 15,
                    }}
                  >
                    <Check className="w-10 h-10 text-white stroke-[3]" />
                  </motion.div>
                )}
                {isError && (
                  <motion.div
                    key="error"
                    initial={{ opacity: 0, scale: 0, rotate: 180 }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    transition={{ 
                      type: "spring",
                      stiffness: 200,
                      damping: 15,
                    }}
                  >
                    <X className="w-10 h-10 text-white stroke-[3]" />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>

            {/* Success particles */}
            {isSuccess && (
              <>
                {[...Array(6)].map((_, i) => (
                  <motion.div
                    key={i}
                    className="absolute w-2 h-2 rounded-full bg-green-500"
                    initial={{ 
                      opacity: 1, 
                      scale: 0,
                      x: 0, 
                      y: 0 
                    }}
                    animate={{ 
                      opacity: 0, 
                      scale: 1,
                      x: Math.cos(i * 60 * Math.PI / 180) * 40,
                      y: Math.sin(i * 60 * Math.PI / 180) * 40,
                    }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                  />
                ))}
              </>
            )}
          </div>

          {/* Text Content */}
          <div className="text-center space-y-2">
            <motion.h3
              className="text-lg font-semibold"
              key={displayPhase}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              {isPending && "Verifying..."}
              {isSuccess && "Verification Successful"}
              {isError && "Verification Failed"}
            </motion.h3>
            
            {backendName && (
              <motion.p
                className="text-sm text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.1 }}
              >
                {backendName}
              </motion.p>
            )}
            
            {message && (isSuccess || isError) && (
              <motion.p
                className={cn(
                  "text-xs px-3 py-1.5 rounded-lg mt-2",
                  isSuccess && "bg-green-500/10 text-green-600",
                  isError && "bg-red-500/10 text-red-600"
                )}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
              >
                {message}
              </motion.p>
            )}
          </div>

          {/* Progress indicator */}
          <div className="w-full h-1 bg-secondary rounded-full overflow-hidden">
            <motion.div
              className={cn(
                "h-full rounded-full",
                isPending && "bg-primary",
                isSuccess && "bg-green-500",
                isError && "bg-red-500"
              )}
              initial={{ width: "0%" }}
              animate={{ 
                width: isPending ? "70%" : "100%",
              }}
              transition={{ 
                duration: isPending ? 1 : 0.3, 
                ease: isPending ? "easeInOut" : "easeOut" 
              }}
            />
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
