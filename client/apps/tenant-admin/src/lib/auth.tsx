"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const STORAGE_KEY = "tenant_admin_auth";

export function useTenantAdminAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsAuthenticated(window.localStorage.getItem(STORAGE_KEY) === "true");
  }, []);

  const login = () => {
    window.localStorage.setItem(STORAGE_KEY, "true");
    setIsAuthenticated(true);
  };

  const logout = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setIsAuthenticated(false);
  };

  return { isAuthenticated, login, logout };
}

export function RequireTenantAdminAuth({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isAuthenticated } = useTenantAdminAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isAuthenticated && pathname !== "/login") {
      router.replace("/login");
    }
  }, [isAuthenticated, pathname, router]);

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
