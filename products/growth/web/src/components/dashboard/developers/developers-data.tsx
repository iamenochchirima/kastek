import { createContext, useContext, type ReactNode } from "react";
import type { DevelopersBootstrap } from "@/lib/developers";

const DevelopersDataContext = createContext<DevelopersBootstrap | null>(null);

export function DevelopersDataProvider({
  value,
  children,
}: {
  value: DevelopersBootstrap;
  children: ReactNode;
}) {
  return <DevelopersDataContext.Provider value={value}>{children}</DevelopersDataContext.Provider>;
}

export function useDevelopersData() {
  const value = useContext(DevelopersDataContext);
  if (!value) throw new Error("useDevelopersData must be used inside DevelopersDataProvider");
  return value;
}
