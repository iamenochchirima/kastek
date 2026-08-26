import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "outline" | "ghost" | "destructive" | "link";
type Size = "sm" | "md" | "lg" | "icon";

const variants: Record<Variant, string> = {
  primary: "border-transparent bg-primary text-primary-foreground hover:bg-brand-strong",
  secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
  outline: "border-border bg-background text-foreground shadow-card hover:bg-accent hover:text-accent-foreground",
  ghost: "border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  destructive: "border-transparent bg-destructive text-destructive-foreground hover:opacity-90",
  link: "border-transparent bg-transparent px-0 text-primary underline-offset-4 hover:underline",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-3.5 text-sm",
  lg: "h-10 px-6 text-sm",
  icon: "size-9 p-0",
};

export function buttonClassName({ variant = "primary", size = "md", className = "" }: { variant?: Variant; size?: Size; className?: string } = {}) {
  return cn("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium outline-none transition-all duration-[var(--v-motion-fast)] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50", variants[variant], sizes[size], className);
}

export function Button({ variant, size, className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClassName({ variant, size, className })} {...props} />;
}
