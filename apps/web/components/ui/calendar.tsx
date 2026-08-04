"use client"

import * as React from "react"
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import { DayPicker } from "react-day-picker"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      navLayout={props.navLayout ?? "around"}
      className={cn("p-3", className)}
      classNames={{
        root: "w-fit",
        months: "relative flex flex-col gap-4",
        month: "grid grid-cols-[2rem_1fr_2rem] grid-rows-[2.25rem_auto] items-center gap-y-3",
        nav: "contents",
        button_previous: cn(
          buttonVariants({ variant: "ghost" }),
          "col-start-1 row-start-1 justify-self-start h-7 w-7 p-0 opacity-70 hover:opacity-100",
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost" }),
          "col-start-3 row-start-1 justify-self-end h-7 w-7 p-0 opacity-70 hover:opacity-100",
        ),
        month_caption: "col-start-2 row-start-1 flex h-9 items-center justify-center",
        caption_label: "text-sm font-medium",
        dropdowns: "flex items-center gap-1",
        dropdown_root:
          "relative has-focus:border-ring has-focus:ring-ring/50 border border-input shadow-xs has-focus:ring-[3px] rounded-md",
        dropdown: "absolute inset-0 opacity-0",
        month_grid: "col-span-3 w-full border-collapse",
        weekdays: "flex",
        weekday:
          "text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]",
        week: "flex w-full mt-2",
        day: "relative h-9 w-9 p-0 text-center text-sm",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "h-9 w-9 p-0 font-normal aria-selected:opacity-100",
        ),
        selected:
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
        today: "bg-accent text-accent-foreground",
        outside: "text-muted-foreground opacity-50",
        disabled: "text-muted-foreground opacity-50",
        range_middle:
          "aria-selected:bg-accent aria-selected:text-accent-foreground",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className, ...props }) => {
          if (orientation === "left") {
            return <ChevronLeft className={cn("h-4 w-4", className)} {...props} />
          }
          if (orientation === "right") {
            return <ChevronRight className={cn("h-4 w-4", className)} {...props} />
          }
          return <ChevronDown className={cn("h-4 w-4", className)} {...props} />
        },
      }}
      {...props}
    />
  )
}

export { Calendar }
