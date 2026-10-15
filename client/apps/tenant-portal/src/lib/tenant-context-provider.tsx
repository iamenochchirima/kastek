"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { useLocation } from "react-router-dom";
import { useAppearance } from "@/lib/appearance";
import { getAgencyWorkspaceSlug, tenantFetch } from "@/lib/api";
import {
  buildTenantThemeStyle,
  getTenantDisplayName,
  getTenantFeatureConfig,
  getTenantLogoUrl,
  getTenantTagline,
  normalizeTenantContext,
  type PublicTenantContext,
  type TenantFeatureConfig,
  type TenantThemeStyle,
} from "@/lib/tenant-context";

type TenantContextValue = {
  context: PublicTenantContext;
  isLoading: boolean;
  refresh: () => Promise<void>;
  brandName: string;
  tagline: string;
  logoUrl: string | null;
  themeStyle: TenantThemeStyle;
  features: TenantFeatureConfig;
};

const DEFAULT_CONTEXT: PublicTenantContext = {
  workspace: null,
  branding: null,
};

const TenantContext = createContext<TenantContextValue | null>(null);

async function fetchTenantContext() {
  const payload = await tenantFetch<unknown>("/api/public/tenant-context", {
    method: "GET",
  });

  return normalizeTenantContext(payload);
}

export function TenantContextProvider({
  children,
  initialContext,
}: {
  children: React.ReactNode;
  initialContext?: PublicTenantContext | null;
}) {
  const location = useLocation();
  const appearance = useAppearance();
  const [context, setContext] = useState<PublicTenantContext>(initialContext ?? DEFAULT_CONTEXT);
  const [isLoading, setIsLoading] = useState(!initialContext?.workspace && !initialContext?.branding);
  const shouldRefreshOnMount = !initialContext?.workspace && !initialContext?.branding;

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const nextContext = await fetchTenantContext();
      setContext(nextContext);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const selectedSlug = getAgencyWorkspaceSlug();
    if (shouldRefreshOnMount || (selectedSlug && selectedSlug !== initialContext?.workspace?.slug)) {
      void refresh().catch(() => {});
    }
  }, [initialContext?.workspace?.slug, refresh, shouldRefreshOnMount]);

  useEffect(() => {
    // Partner preferences are independent of a business's branded workspace.
    const partnerPage = location.pathname.startsWith('/app/') || location.pathname === '/onboarding' || location.pathname === '/register' || (location.pathname === '/login' && new URLSearchParams(location.search).get('audience') === 'partner');
    const style = partnerPage ? {} : buildTenantThemeStyle(context);
    const root = document.documentElement;
    const keys = ['--primary','--ring','--sidebar-primary','--sidebar-ring','--chart-1','--primary-foreground','--sidebar-primary-foreground','--secondary','--accent','--sidebar-accent','--chart-2'];
    keys.forEach(key => root.style.removeProperty(key));
    Object.entries(style).forEach(([key,value]) => root.style.setProperty(key,value));
  }, [context, location.pathname, location.search, appearance]);

  useEffect(() => {
    const partnerPage = location.pathname.startsWith('/app/') || location.pathname === '/onboarding' || location.pathname === '/register' || (location.pathname === '/login' && new URLSearchParams(location.search).get('audience') === 'partner');
    document.title = partnerPage || (!context.workspace && !context.branding) ? 'KasiTek Agency' : getTenantDisplayName(context);
  }, [context, location.pathname, location.search]);

  const value = useMemo<TenantContextValue>(() => {
    return {
      context,
      isLoading,
      refresh,
      brandName: getTenantDisplayName(context),
      tagline: getTenantTagline(context),
      logoUrl: getTenantLogoUrl(context),
      themeStyle: buildTenantThemeStyle(context),
      features: getTenantFeatureConfig(context),
    };
  }, [context, isLoading, refresh]);

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenantContext() {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error("useTenantContext must be used within TenantContextProvider");
  }

  return context;
}
