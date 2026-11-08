import { lazy, Suspense } from "react";
import { Routes, Route, useParams, useSearchParams } from "react-router-dom";
import { AgencyShell } from "@/components/agency-shell";
import { AppearanceSettings } from "@/components/appearance-settings";
import { useTenantContext } from "@/lib/tenant-context-provider";
const screens = import.meta.glob<{ default: React.ComponentType<any> }>(
  "./screens/*.tsx",
);
function screen(name: string) {
  return lazy(screens[`./screens/${name}.tsx`]);
}
const Home = screen("tenant-home"),
  Login = screen("login"),
  PartnerLogin = screen("partner-login"),
  Register = PartnerLogin,
  Onboarding = screen("partner-onboarding"),
  Businesses = screen("partner-businesses"),
  Business = screen("partner-business-settings"),
  Portal = screen("portal-entry"),
  ClientDetail = screen("client-detail"),
  ClientAgent = screen("client-agent"),
  Conversation = screen("client-conversation-detail");
function SignIn() {
  const [query] = useSearchParams();
  const { context, isLoading } = useTenantContext();
  if (isLoading) return <RouteLoading />;
  return query.get("audience") === "partner" ||
    (query.get("audience") !== "tenant" &&
      !context.workspace &&
      !context.branding) ? (
    <PartnerLogin error={query.get("error") || undefined} />
  ) : (
    <Login />
  );
}
function Detail({
  kind,
}: {
  kind: "business" | "client" | "conversation" | "portal" | "client-agent";
}) {
  const params = useParams();
  const [query] = useSearchParams();
  if (kind === "business")
    return <Business key={params.id} businessId={params.id!} />;
  if (kind === "portal")
    return <Portal key={params.slug} slug={params.slug!} />;
  if (kind === "conversation")
    return <Conversation key={params.id} conversationId={params.id!} />;
  if (kind === "client-agent") return <ClientAgent key={params.id} clientId={params.id!} />;
  return (
    <ClientDetail
      key={params.id}
      clientId={params.id!}
      initialAdminInviteEmail={query.get("adminInviteEmail")}
      initialAdminInviteSent={query.get("adminInviteSent") === "1"}
      initialAdminInviteUrl={query.get("adminInviteUrl")}
    />
  );
}
export function RouteLoading() {
  return (
    <div
      role="status"
      className="grid min-h-[40vh] place-items-center text-sm text-muted-foreground"
    >
      Loading workspace…
    </div>
  );
}
const others = [
  ["/setup", "admin-setup"],
  ["/activate", "accept-invite"],
  ["/clients", "clients"],
  ["/leads", "leads"],
  ["/content", "content"],
  ["/reporting", "reporting"],
  ["/nurturing", "nurturing"],
  ["/aeo", "aeo"],
  ["/voice", "voice"],
  ["/reviews", "reviews"],
  ["/adcreative", "adcreative"],
  ["/settings", "settings"],
  ["/billing", "billing"],
  ["/client", "client-home"],
  ["/client/leads", "client-leads"],
  ["/client/conversations", "client-conversations"],
  ["*", "not-found"],
].map(([path, name]) => ({ path, Component: screen(name) }));
export function AgencyRoutes() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route
          path="/app/appearance"
          element={
            <AgencyShell mode="partner">
              <div className="mx-auto max-w-3xl p-4 sm:p-7">
                <AppearanceSettings />
              </div>
            </AgencyShell>
          }
        />
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<SignIn />} />
        <Route path="/register" element={<Register intent="register" />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/app/businesses" element={<Businesses />} />
        <Route
          path="/app/businesses/:id"
          element={<Detail kind="business" />}
        />
        <Route path="/portal/:slug" element={<Detail kind="portal" />} />
        <Route path="/clients/:id" element={<Detail kind="client" />} />
        <Route path="/clients/:id/agent" element={<Detail kind="client-agent" />} />
        <Route
          path="/client/conversations/:id"
          element={<Detail kind="conversation" />}
        />
        {others.map(({ path, Component }) => (
          <Route key={path} path={path} element={<Component />} />
        ))}
      </Routes>
    </Suspense>
  );
}
