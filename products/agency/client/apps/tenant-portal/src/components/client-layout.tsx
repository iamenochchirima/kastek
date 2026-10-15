import { AgencyShell } from '@/components/agency-shell';
export function ClientLayout({children}:{children:React.ReactNode}) {
  return <AgencyShell mode="client"><div className="mx-auto max-w-7xl px-4 py-8 sm:px-7">{children}</div></AgencyShell>;
}
