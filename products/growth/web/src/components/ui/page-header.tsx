import * as React from "react"

import { cn } from "@/lib/utils"

function PageHeader({ className, ...props }: React.ComponentProps<"header">) {
  return <header data-slot="page-header" className={cn("flex flex-wrap items-center gap-3", className)} {...props} />
}

function PageHeaderContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="page-header-content" className={cn("min-w-0 flex-1", className)} {...props} />
}

function PageHeaderTitle({ className, ...props }: React.ComponentProps<"h1">) {
  return <h1 data-slot="page-header-title" className={cn("text-xl leading-7 font-semibold tracking-[-0.025em] text-ink-1", className)} {...props} />
}

function PageHeaderDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="page-header-description" className={cn("mt-0.5 text-[13px] text-ink-2", className)} {...props} />
}

function PageHeaderActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="page-header-actions" className={cn("flex w-full flex-wrap items-center gap-2 [&_svg]:size-4 [&_svg]:stroke-[1.5] sm:ml-auto sm:w-auto", className)} {...props} />
}

export { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle }
