import type { HTMLAttributes, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <div className="admin-table-wrap"><table data-slot="table" className={cn("w-full text-sm", className)} {...props} /></div>;
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead data-slot="table-header" className={cn("admin-table-head border-b border-line", className)} {...props} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody data-slot="table-body" className={cn("divide-y divide-line", className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr data-slot="table-row" className={cn("transition-colors hover:bg-accent", className)} {...props} />;
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th data-slot="table-head" className={cn("px-4 py-3 text-left text-xs font-medium text-muted-foreground", className)} {...props} />;
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td data-slot="table-cell" className={cn("px-4 py-3 text-foreground", className)} {...props} />;
}
