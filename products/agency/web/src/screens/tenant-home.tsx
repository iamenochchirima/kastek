"use client";

import { useEffect } from 'react';
import { useRouter } from '@/lib/navigation';
import DashboardPage from '@/screens/dashboard';
import AgencyLandingScreen from '@/screens/agency-landing';
import { useAuth } from '@/lib/auth';
import { useTenantContext } from '@/lib/tenant-context-provider';
import { tenantFetch } from '@/lib/api';

export default function TenantHome() {
  const router = useRouter();
  const { audience, isLoading: authLoading } = useAuth();
  const { context, isLoading: contextLoading } = useTenantContext();

  useEffect(() => {
    if (!authLoading && audience === 'client') router.replace('/client');
  }, [audience, authLoading, router]);

  useEffect(() => {
    if (authLoading || contextLoading || audience) return;
    let active = true;
    void tenantFetch('/api/partner/auth/me')
      .then(() => { if (active) router.replace('/app/businesses'); })
      .catch(() => {});
    return () => { active = false; };
  }, [audience, authLoading, context.branding, context.workspace, contextLoading, router]);

  if (authLoading || (contextLoading && !context.workspace)) return <AgencyLandingScreen />;
  if (!audience) return <AgencyLandingScreen />;
  return context.workspace ? <DashboardPage /> : <AgencyLandingScreen />;
}
