"use client";

import React, { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setIsAuthenticated(window.localStorage.getItem("agency_auth") === "true");
  }, []);

  const login = () => {
    window.localStorage.setItem("agency_auth", "true");
    setIsAuthenticated(true);
  };

  const logout = () => {
    window.localStorage.removeItem("agency_auth");
    setIsAuthenticated(false);
  };

  return { isAuthenticated, login, logout };
}

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isAuthenticated && pathname !== "/login") {
      router.replace("/login");
    }
  }, [isAuthenticated, pathname, router]);

  if (!isAuthenticated) return null;

  return <>{children}</>;
}
