"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner } from "sonner"
import { CheckCircle2, XCircle, AlertTriangle, Info } from "lucide-react"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CheckCircle2 className="w-4 h-4 text-emerald-500" />,
        error: <XCircle className="w-4 h-4 text-red-500" />,
        warning: <AlertTriangle className="w-4 h-4 text-amber-500" />,
        info: <Info className="w-4 h-4 text-blue-500" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "group toast max-w-[calc(100vw-32px)] sm:max-w-none group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground break-words whitespace-pre-wrap",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toaster]:text-muted-foreground",
          success: "group-[.toaster]:border-emerald-500/30",
          error: "group-[.toaster]:border-red-500/30",
          warning: "group-[.toaster]:border-amber-500/30",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
