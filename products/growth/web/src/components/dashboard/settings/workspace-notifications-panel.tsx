"use client";

import { useSyncExternalStore } from "react";
import {
  AtSign,
  Gauge,
  LockKeyhole,
  Mail,
  Megaphone,
  MessageSquare,
  ShieldAlert,
  UserPlus,
} from "lucide-react";
import InboxAlertControls from "@/components/dashboard/inbox/inbox-alert-controls";
import PushNotificationSettings from "@/components/dashboard/notifications/push-notification-settings";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type NotificationCategory = "updates" | "digest" | "mentions" | "security" | "usage" | "customers";
type NotificationChannel = "email" | "push" | "slack";

type NotificationPreferences = {
  enabled: Record<NotificationCategory, boolean>;
  channels: Record<NotificationCategory, Record<NotificationChannel, boolean>>;
};

const STORAGE_KEY = "kasitek:workspace-notification-preferences";

const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: {
    updates: true,
    digest: true,
    mentions: true,
    security: true,
    usage: true,
    customers: false,
  },
  channels: {
    updates: { email: true, push: false, slack: false },
    digest: { email: true, push: false, slack: false },
    mentions: { email: true, push: true, slack: true },
    security: { email: true, push: true, slack: false },
    usage: { email: true, push: false, slack: true },
    customers: { email: false, push: false, slack: false },
  },
};

const NOTIFICATION_ROWS: Array<{
  id: NotificationCategory;
  title: string;
  description: string;
  icon: typeof Megaphone;
  badge?: string;
  locked?: boolean;
}> = [
  { id: "updates", title: "Product updates", description: "New features and improvements, roughly monthly.", icon: Megaphone },
  { id: "digest", title: "Weekly digest", description: "A summary of your workspace metrics every Monday.", icon: Mail },
  { id: "mentions", title: "Mentions & comments", description: "When a teammate mentions you or comments on your reports.", icon: AtSign },
  { id: "security", title: "Security alerts", description: "Sign-ins from new devices and key changes.", icon: ShieldAlert, locked: true },
  { id: "usage", title: "Usage limit warnings", description: "Heads-up at 80% and 95% of plan limits.", icon: Gauge },
  { id: "customers", title: "New customer alerts", description: "Real-time ping when a customer signs up.", icon: UserPlus, badge: "REAL-TIME" },
];

function readPreferences(): NotificationPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<NotificationPreferences> | null;
    if (!value?.enabled || !value.channels) return DEFAULT_PREFERENCES;
    return {
      enabled: { ...DEFAULT_PREFERENCES.enabled, ...value.enabled },
      channels: Object.fromEntries(
        Object.entries(DEFAULT_PREFERENCES.channels).map(([id, defaults]) => [
          id,
          { ...defaults, ...(value.channels?.[id as NotificationCategory] ?? {}) },
        ]),
      ) as NotificationPreferences["channels"],
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

let preferencesSnapshot: NotificationPreferences = typeof window === "undefined" ? DEFAULT_PREFERENCES : readPreferences();
const preferenceListeners = new Set<() => void>();

function subscribeToPreferences(listener: () => void) {
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
}

function updatePreferences(next: NotificationPreferences) {
  preferencesSnapshot = next;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  for (const listener of preferenceListeners) listener();
}

export function WorkspaceNotificationsPanel() {
  const preferences = useSyncExternalStore(subscribeToPreferences, () => preferencesSnapshot, () => DEFAULT_PREFERENCES);

  function persist(next: NotificationPreferences) {
    updatePreferences(next);
  }

  function toggleCategory(id: NotificationCategory, enabled: boolean) {
    persist({ ...preferences, enabled: { ...preferences.enabled, [id]: enabled } });
  }

  function toggleChannel(id: NotificationCategory, channel: NotificationChannel) {
    if (!preferences.enabled[id]) return;
    persist({
      ...preferences,
      channels: {
        ...preferences.channels,
        [id]: { ...preferences.channels[id], [channel]: !preferences.channels[id][channel] },
      },
    });
  }

  return (
    <div className="space-y-5">
      <section className="v-settings-card rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-panel)] sm:p-5">
        <div>
          <h2 className="text-base font-semibold text-foreground">Notifications</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Choose which workspace events reach you.</p>
        </div>

        <div className="mt-4 divide-y divide-border">
          {NOTIFICATION_ROWS.map((row) => {
            const Icon = row.icon;
            const enabled = preferences.enabled[row.id];
            return (
              <article key={row.id} className="flex gap-3 py-4 first:pt-1 last:pb-1 sm:gap-4">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                  <Icon className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium text-foreground">
                        {row.title}
                        {row.badge ? <span className="ml-2 inline-flex rounded-full border border-status-success/30 bg-status-success-soft px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-[0.08em] text-status-success">{row.badge}</span> : null}
                      </h3>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{row.description}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {row.locked ? <LockKeyhole className="size-3.5 text-muted-foreground" aria-label="Always enabled" /> : null}
                      <Switch
                        checked={enabled}
                        disabled={row.locked}
                        onCheckedChange={(checked) => toggleCategory(row.id, checked)}
                        aria-label={`${row.title}: ${enabled ? "on" : "off"}`}
                      />
                    </div>
                  </div>

                  <div className={cn("mt-3 flex flex-wrap gap-2 transition-opacity", !enabled && "pointer-events-none opacity-45")}>
                    {(["email", "push", "slack"] as const).map((channel) => {
                      const checked = preferences.channels[row.id][channel];
                      const label = channel[0].toUpperCase() + channel.slice(1);
                      return (
                        <button
                          key={channel}
                          type="button"
                          disabled={!enabled}
                          onClick={() => toggleChannel(row.id, channel)}
                          aria-pressed={checked}
                          className={cn(
                            "inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            checked
                              ? "border-primary/20 bg-primary/10 text-primary"
                              : "border-border bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
                          )}
                        >
                          {checked ? <span aria-hidden="true" className="mr-1.5">✓</span> : null}
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="v-settings-card rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-panel)] sm:p-5">
        <div className="flex items-start gap-3">
          <MessageSquare className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">Device delivery</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Browser and mobile notifications for new inbox messages.</p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <PushNotificationSettings embedded />
          <div className="rounded-lg border border-border bg-secondary/20 p-4">
            <h3 className="text-sm font-semibold text-foreground">Inbox alerts</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Desktop popups and sound while KasiTek is open.</p>
            <div className="mt-3"><InboxAlertControls title="KasiTek Inbox Alerts" showStatus compact /></div>
          </div>
        </div>
      </section>
    </div>
  );
}
