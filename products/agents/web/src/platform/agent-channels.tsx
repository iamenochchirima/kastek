import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { channelApi, channelError, channelNames, type ChannelConnection, type ChannelList } from "./channel-api";
import { loadFacebookSdk, type FacebookSdk } from "./facebook-sdk";
import { WebsiteChannelSettings } from "./website-channel-settings";

type Provider = "facebook" | "instagram" | "whatsapp";
type Organization = { id: string; name: string };
type Asset = { connectionId: string; providerAssetId: string; name: string; handle: string | null; permissionRevision: string; inbound: true; outbound: true };
type OAuthBegin = { operation: "oauth.begin"; flow: "oauth"; authorizationUrl: string } |
  { operation: "oauth.begin"; flow: "embedded_signup"; intentId: string; appId: string; apiVersion: string; configurationId: string; messageOrigins: string[] };
export function AgentChannels({ organizationId, agentId, owner, hideWebsite = false }: { organizationId: string; agentId: string; owner: boolean; hideWebsite?: boolean }) {
  const [params, setParams] = useSearchParams();
  const { confirm } = useConfirmationDialog();
  const [list, setList] = useState<ChannelList | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organization, setOrganization] = useState("");
  const [provider, setProvider] = useState<Provider | null>(null);
  const [intentId, setIntentId] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signup, setSignup] = useState<Extract<OAuthBegin, { flow: "embedded_signup" }> | null>(null);
  const [sdk, setSdk] = useState<FacebookSdk | null>(null);
  const [signupCode, setSignupCode] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const websites = useMemo(() => list?.websites.filter(item => item.agentId === agentId) ?? [], [list, agentId]);

  async function refresh() {
    const current = await channelApi<ChannelList>(organizationId);
    setList(current);
    return current;
  }
  async function loadAssets(id: string, forProvider: Provider) {
    const result = await channelApi<{ assets: Asset[] }>(organizationId, `/growth/intents/${id}/assets`, { agentId });
    setAssets(result.assets);
    setAssetId(result.assets[0]?.providerAssetId ?? "");
    setIntentId(id);
    setProvider(forProvider);
  }
  useEffect(() => {
    let live = true;
    void Promise.all([
      channelApi<ChannelList>(organizationId),
      owner ? channelApi<{ organizations: Organization[] }>(organizationId, "/growth/organizations", { agentId }) : Promise.resolve({ organizations: [] }),
    ]).then(([channels, growth]) => {
      if (!live) return;
      setList(channels);
      setOrganizations(growth.organizations);
      setOrganization(growth.organizations[0]?.id ?? "");
    }).catch(cause => { if (live) setError(channelError(cause)); });
    return () => { live = false; };
  }, [organizationId, owner, agentId]);

  useEffect(() => {
    const id = params.get("growthIntent"), channel = params.get("growthChannel"), result = params.get("growthResult");
    if (!id || !channel || !["facebook", "instagram", "whatsapp"].includes(channel)) return;
    setIntentId(id);
    setProvider(channel as Provider);
    const next = new URLSearchParams(params);
    next.delete("growthIntent"); next.delete("growthChannel"); next.delete("growthResult");
    setParams(next, { replace: true });
    if (result === "connected") {
      setBusy(true);
      void loadAssets(id, channel as Provider).then(() => toast.success("Growth account connected")).catch(cause => setError(channelError(cause))).finally(() => setBusy(false));
    } else if (result === "cancelled") setError("Authorization cancelled.");
    else if (result) setError("Growth could not connect this account. Try again.");
    // The callback intent is actor, workspace and Agent bound by Growth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    if (!signup) return;
    const allowed = new Set(signup.messageOrigins.filter(origin => ["https://www.facebook.com", "https://web.facebook.com"].includes(origin)));
    const onMessage = (event: MessageEvent) => {
      if (!allowed.has(event.origin) || !event.source || event.source === window) return;
      let payload: unknown = event.data;
      try { if (typeof payload === "string") payload = JSON.parse(payload); } catch { return; }
      if (!payload || typeof payload !== "object") return;
      const response = payload as { type?: string; event?: string; data?: { waba_id?: unknown; phone_number_id?: unknown } };
      if (response.type !== "WA_EMBEDDED_SIGNUP") return;
      if (response.event === "FINISH" && typeof response.data?.waba_id === "string" && typeof response.data.phone_number_id === "string") {
        setWabaId(response.data.waba_id); setPhoneNumberId(response.data.phone_number_id);
      } else if (response.event === "CANCEL" || response.event === "ERROR") setError("WhatsApp signup was not completed.");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [signup]);

  useEffect(() => {
    if (!signup || !signupCode || !wabaId || !phoneNumberId) return;
    setBusy(true);
    void channelApi<{ authorized: true }>(organizationId, `/growth/intents/${signup.intentId}/whatsapp/complete`, { agentId, code: signupCode, wabaId, phoneNumberId })
      .then(() => loadAssets(signup.intentId, "whatsapp"))
      .catch(cause => setError(channelError(cause)))
      .finally(() => { setBusy(false); setSignup(null); setSignupCode(""); setWabaId(""); setPhoneNumberId(""); });
    // The code is exchanged once and retained only in component memory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, agentId, signup, signupCode, wabaId, phoneNumberId]);

  async function begin(providerValue: Provider) {
    if (!organization) { setError("Choose a Growth organization."); return; }
    setBusy(true); setError(""); setAssets([]); setAssetId("");
    try {
      const created = await channelApi<{ intentId: string }>(organizationId, "/growth/intents", { agentId, provider: providerValue, growthOrganizationId: organization });
      setIntentId(created.intentId); setProvider(providerValue);
      const listed = await channelApi<{ assets: Asset[] }>(organizationId, `/growth/intents/${created.intentId}/assets`, { agentId });
      setAssets(listed.assets); setAssetId(listed.assets[0]?.providerAssetId ?? "");
    } catch (cause) { setError(channelError(cause)); }
    finally { setBusy(false); }
  }
  async function connectGrowthAccount(loginMode: "meta_login" | "instagram_login" | "whatsapp_embedded_signup") {
    if (!provider || !intentId) return;
    setBusy(true); setError("");
    try {
      const result = await channelApi<OAuthBegin>(organizationId, `/growth/intents/${intentId}/oauth`, { agentId, loginMode });
      if (result.flow === "oauth") { window.location.assign(result.authorizationUrl); return; }
      setSignup(result);
      setSdk(await loadFacebookSdk(result.appId, result.apiVersion));
    } catch (cause) { setError(channelError(cause)); }
    finally { setBusy(false); }
  }
  async function selectAsset() {
    if (!provider || !intentId || !assetId) return;
    const asset = assets.find(item => item.providerAssetId === assetId);
    if (!asset) return;
    setBusy(true); setError("");
    try {
      await channelApi(organizationId, `/growth/intents/${intentId}/select`, { agentId, connectionId: asset.connectionId, providerAssetId: asset.providerAssetId });
      await refresh();
      setAssets([]); setIntentId(""); setProvider(null);
      toast.success(`${channelNames[provider]} connected to agent`);
    } catch (cause) { setError(channelError(cause)); }
    finally { setBusy(false); }
  }
  async function disconnect(connection: ChannelConnection) {
    if (!await confirm({ title: `Disconnect ${connection.name}?`, description: "The Agent will stop receiving and sending messages on this channel.", confirmLabel: "Disconnect", variant: "destructive" })) return;
    setBusy(true); setError("");
    try {
      await channelApi(organizationId, `/${connection.id}/disconnect`, { expectedRevision: connection.revision });
      await refresh(); toast.success("Agent channel disconnected");
    } catch (cause) { setError(channelError(cause)); }
    finally { setBusy(false); }
  }
  const activeChannels = list?.connections.filter(connection => connection.kind !== "website" &&
    list.deployments.some(binding => binding.connectionId === connection.id && binding.agentId === agentId && binding.state === "active")) ?? [];

  return <div className="max-w-3xl space-y-6" aria-label="Agent channels">
    <section className="agent-config-panel space-y-4">
      <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">Channels</h2></div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {activeChannels.length ? <ul className="divide-y rounded-md border">{activeChannels.map(connection => <li key={connection.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
        <div><p className="text-sm font-medium">{connection.name}</p><p className="text-xs text-muted-foreground">{channelNames[connection.kind]} · {connection.providerHealth === "needs_attention" ? "Needs attention" : connection.state === "active" ? "Connected" : connection.state}</p></div>
        {owner ? <div className="flex gap-2">
          {connection.providerHealth === "needs_attention" && ["facebook","instagram","whatsapp"].includes(connection.kind)
            ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void begin(connection.kind as Provider)}>Reconnect</Button> : null}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void disconnect(connection)}>Disconnect</Button>
        </div> : null}
      </li>)}</ul> : <p className="text-sm text-muted-foreground">No social channels connected</p>}
      {owner ? <>
        <label className="block space-y-2 text-sm">Growth organization
          <select className="min-h-10 w-full rounded-md border bg-background px-3" value={organization} onChange={event => setOrganization(event.target.value)} disabled={busy || !organizations.length}>
            {!organizations.length ? <option value="">No Growth organizations</option> : null}
            {organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">{(["facebook", "instagram", "whatsapp"] as const).map(item =>
          <Button key={item} variant="outline" disabled={busy || !organization} onClick={() => void begin(item)}>Connect {item === "facebook" ? "Facebook Page" : item === "instagram" ? "Instagram" : "WhatsApp"}</Button>)}</div>
      </> : null}
      {provider && intentId ? <div className="space-y-3 rounded-md border p-4">
        <div className="flex items-center justify-between"><h3 className="text-sm font-medium">{channelNames[provider]} account</h3><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setAssets([]); setIntentId(""); setProvider(null); setError(""); }}>Cancel</Button></div>
        {assets.length ? <>
          <label className="block space-y-2 text-sm">Account
            <select className="min-h-10 w-full rounded-md border bg-background px-3" value={assetId} disabled={busy} onChange={event => setAssetId(event.target.value)}>
              {assets.map(item => <option key={item.connectionId} value={item.providerAssetId}>{item.name}{item.handle ? ` · @${item.handle}` : ""}</option>)}
            </select>
          </label>
          <Button disabled={busy || !assetId} onClick={() => void selectAsset()}>{busy ? "Connecting…" : "Connect selected account"}</Button>
        </> : <>
          <p className="text-sm text-muted-foreground">No eligible Growth account found.</p>
          {provider === "facebook" ? <Button disabled={busy} onClick={() => void connectGrowthAccount("meta_login")}>Connect Facebook account</Button> : null}
          {provider === "instagram" ? <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void connectGrowthAccount("meta_login")}>Connect through Facebook</Button><Button variant="outline" disabled={busy} onClick={() => void connectGrowthAccount("instagram_login")}>Connect with Instagram</Button></div> : null}
          {provider === "whatsapp" ? <Button disabled={busy} onClick={() => void connectGrowthAccount("whatsapp_embedded_signup")}>Continue with Facebook</Button> : null}
        </>}
      </div> : null}
      {signup ? <div className="space-y-3 rounded-md border p-4"><p className="text-sm">WhatsApp signup</p><Button disabled={!sdk || busy} onClick={() => {
        setError("");
        sdk?.login(response => { if (response.authResponse?.code) setSignupCode(response.authResponse.code); else setError("WhatsApp signup was not completed."); }, {
          config_id: signup.configurationId, response_type: "code", override_default_response_type: true,
          extras: { setup: {}, sessionInfoVersion: "3" }, state: signup.intentId,
        });
      }}>Open Facebook signup</Button></div> : null}
    </section>
    {hideWebsite ? <section className="agent-config-panel space-y-3">
      <div><h2 className="text-base font-semibold">Website</h2></div>
      {websites.length ? <ul className="divide-y rounded-md border">{websites.map(site => <li key={site.id} className="space-y-1 p-3"><p className="text-sm font-medium">{site.agentName}</p><p className="break-all text-xs text-muted-foreground">{site.allowedOrigins.join(", ")}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">No website widget connected</p>}
      <Link className="text-sm underline underline-offset-4" to={`/app/agents/${encodeURIComponent(agentId)}?section=widget`}>{websites.length ? "Customize widget" : "Connect website"}</Link>
    </section> : <section className="agent-config-panel space-y-3">
      <div><h2 className="text-base font-semibold">Website</h2></div>
      {websites.length ? <WebsiteChannelSettings organizationId={organizationId} agentId={agentId} owner={owner} showConnect={false} /> :
        <WebsiteChannelSettings organizationId={organizationId} agentId={agentId} owner={owner} />}
    </section>}
  </div>;
}
