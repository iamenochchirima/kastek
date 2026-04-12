"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Globe, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { ProtectedRoute } from "@/lib/auth";
import { Layout } from "@/components/layout";
import { tenantFetch } from "@/lib/api";
import { SETTINGS_ROLES } from "@/lib/tenant-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

type DomainRecord = {
  id: string;
  domain: string;
  isPrimary: boolean;
  dnsStatus: string;
  verifiedAt: string | null;
  verificationMessage: string;
};

type WorkspaceDomainsResponse = {
  hostedDomain: string | null;
  domains: DomainRecord[];
  verification?: {
    expectedTargetHost?: string | null;
    hostedDomainBase?: string | null;
  };
};

type WorkspaceResponse = {
  workspace: {
    slug: string;
    hostedDomain?: string | null;
    domainVerification?: {
      expectedTargetHost?: string | null;
      hostedDomainBase?: string | null;
    };
  };
};

function statusTone(status: string) {
  switch (status) {
    case "verified":
      return "bg-green-500/15 text-green-400";
    case "misconfigured":
      return "bg-amber-500/15 text-amber-400";
    default:
      return "bg-white/5 text-muted-foreground";
  }
}

export default function SettingsScreen() {
  const [hostedDomain, setHostedDomain] = useState<string | null>(null);
  const [expectedTargetHost, setExpectedTargetHost] = useState<string | null>(null);
  const [workspaceSlug, setWorkspaceSlug] = useState<string>("");
  const [domains, setDomains] = useState<DomainRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [makePrimary, setMakePrimary] = useState(false);

  const primaryCustomDomain = useMemo(
    () => domains.find((entry) => entry.isPrimary) ?? null,
    [domains],
  );

  async function loadDomains() {
    setLoading(true);
    setError("");
    try {
      const [workspace, domainPayload] = await Promise.all([
        tenantFetch<WorkspaceResponse>("/api/workspace"),
        tenantFetch<WorkspaceDomainsResponse>("/api/workspace/domains"),
      ]);

      setWorkspaceSlug(workspace.workspace.slug);
      setHostedDomain(domainPayload.hostedDomain ?? workspace.workspace.hostedDomain ?? null);
      setExpectedTargetHost(
        domainPayload.verification?.expectedTargetHost ??
          workspace.workspace.domainVerification?.expectedTargetHost ??
          null,
      );
      setDomains(domainPayload.domains ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load workspace settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDomains();
  }, []);

  async function addDomain(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await tenantFetch("/api/workspace/domains", {
        method: "POST",
        body: JSON.stringify({ domain: newDomain, makePrimary }),
      });
      setNewDomain("");
      setMakePrimary(false);
      await loadDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add domain");
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyDomain(domainId: string) {
    setVerifyingId(domainId);
    setError("");
    try {
      await tenantFetch(`/api/workspace/domains/${domainId}/verify`, { method: "POST" });
      await loadDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to verify domain");
    } finally {
      setVerifyingId(null);
    }
  }

  async function makeDomainPrimary(domainId: string) {
    setPrimaryId(domainId);
    setError("");
    try {
      await tenantFetch(`/api/workspace/domains/${domainId}/primary`, { method: "POST" });
      await loadDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to set primary domain");
    } finally {
      setPrimaryId(null);
    }
  }

  async function removeDomain(domainId: string) {
    setRemovingId(domainId);
    setError("");
    try {
      await tenantFetch(`/api/workspace/domains/${domainId}`, { method: "DELETE" });
      await loadDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove domain");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <ProtectedRoute allowedRoles={SETTINGS_ROLES}>
      <Layout>
        <div className="space-y-8 p-8 animate-in fade-in duration-500">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Workspace Settings</h1>
              <p className="text-muted-foreground">
                Manage your hosted portal domain, connect a branded custom domain, and verify DNS routing.
              </p>
            </div>
            <Button variant="outline" onClick={() => void loadDomains()} disabled={loading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>

          {error ? (
            <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5" />
                  Hosted Domain
                </CardTitle>
                <CardDescription>
                  This is your system-managed fallback portal address. It works immediately and should remain available
                  even after you connect a branded domain.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="font-mono text-sm text-foreground">
                  {loading ? "Loading..." : hostedDomain ?? `${workspaceSlug || "workspace"}.portal.kasitek.co.za`}
                </p>
                <p className="text-sm text-muted-foreground">
                  Share this URL internally while your custom domain is being configured.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe className="h-5 w-5" />
                  DNS Target
                </CardTitle>
                <CardDescription>
                  Point your branded domain at the shared KasiTek portal host, then verify it here.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  Recommended record:
                </p>
                <p className="font-mono text-foreground">
                  {primaryCustomDomain?.domain ?? "portal.yourcompany.com"} CNAME{" "}
                  {expectedTargetHost ?? "portal.kasitek.co.za"}
                </p>
                <p className="text-muted-foreground">
                  Once DNS propagates, hit Verify. A verified custom domain can then be made primary.
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Custom Domain</CardTitle>
              <CardDescription>
                Add your branded domain when you’re ready. KasiTek will keep the hosted fallback domain active in case
                DNS or SSL need troubleshooting.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <form onSubmit={addDomain} className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
                <div className="space-y-2">
                  <Label htmlFor="custom-domain">Custom domain</Label>
                  <Input
                    id="custom-domain"
                    value={newDomain}
                    onChange={(event) => setNewDomain(event.target.value)}
                    placeholder="portal.tomorrowlabs.com"
                    required
                  />
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Checkbox
                      id="make-primary"
                      checked={makePrimary}
                      onCheckedChange={(checked) => setMakePrimary(Boolean(checked))}
                    />
                    <Label htmlFor="make-primary" className="cursor-pointer font-normal">
                      Make this primary after it is added
                    </Label>
                  </div>
                </div>
                <Button type="submit" disabled={submitting}>
                  {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                  Add Domain
                </Button>
              </form>

              <div className="space-y-4">
                {loading ? (
                  <p className="text-sm text-muted-foreground">Loading domains...</p>
                ) : domains.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No custom domains configured yet. Your hosted domain is already active.
                  </p>
                ) : (
                  domains.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-xl border border-border bg-background/60 p-4"
                    >
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm text-foreground">{entry.domain}</span>
                            {entry.isPrimary ? (
                              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                Primary
                              </span>
                            ) : null}
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusTone(entry.dnsStatus)}`}>
                              {entry.dnsStatus}
                            </span>
                            {entry.dnsStatus === "verified" ? (
                              <CheckCircle2 className="h-4 w-4 text-green-400" />
                            ) : null}
                          </div>
                          <p className="text-sm text-muted-foreground">{entry.verificationMessage}</p>
                          <p className="text-xs text-muted-foreground">
                            {entry.verifiedAt
                              ? `Verified ${new Date(entry.verifiedAt).toLocaleString()}`
                              : "Not verified yet"}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void verifyDomain(entry.id)}
                            disabled={verifyingId === entry.id}
                          >
                            {verifyingId === entry.id ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-2 h-4 w-4" />
                            )}
                            Verify
                          </Button>
                          {!entry.isPrimary ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void makeDomainPrimary(entry.id)}
                              disabled={primaryId === entry.id}
                            >
                              {primaryId === entry.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : null}
                              Make Primary
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void removeDomain(entry.id)}
                            disabled={removingId === entry.id}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            {removingId === entry.id ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="mr-2 h-4 w-4" />
                            )}
                            Remove
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </Layout>
    </ProtectedRoute>
  );
}
