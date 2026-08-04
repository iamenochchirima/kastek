import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = { title: "Agent Activity | KasiTek" };

type AgentActivityItem = {
  id: string;
  kind: string;
  createdAt: string;
  botName: string;
  title: string;
  status: string | null;
  channel: string | null;
  responseTimeMs: number | null;
  detail: string | null;
};

export default async function AgentActivityPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const response = await fetchRustJson<{ activity: AgentActivityItem[] }>("/api/bots/activity").catch(() => ({ activity: [] }));

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px]">
        <header className="max-w-3xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Agent activity</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Deployment changes, replies, handoffs and failures recorded by your agents.
          </p>
        </header>

        <section className="mt-8 divide-y divide-border rounded-xl border border-border bg-card">
          {response.activity.length ? response.activity.map((item) => (
            <article key={`${item.kind}:${item.id}`} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm text-foreground"><span className="font-semibold">{item.botName}</span> · {item.title}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {item.channel ? <span>{item.channel}</span> : null}
                  {item.status ? <span>{item.status}</span> : null}
                  {item.responseTimeMs ? <span>{item.responseTimeMs} ms</span> : null}
                </div>
                {item.detail ? <p className="mt-2 text-xs text-destructive">{item.detail}</p> : null}
              </div>
              <time className="shrink-0 text-xs text-muted-foreground" dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString()}
              </time>
            </article>
          )) : (
            <div className="px-5 py-14 text-center">
              <p className="text-sm font-medium text-foreground">No agent activity yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Events will appear here once an agent is deployed and receives work.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
