"use client";

import * as React from "react";

export function Checkbox({
  checked,
  onCheckedChange,
}: {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  return <input type="checkbox" checked={checked} onChange={(event) => onCheckedChange?.(event.target.checked)} className="h-4 w-4 rounded border-border" />;
}
