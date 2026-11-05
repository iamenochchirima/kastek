import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { message } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { customerRecordsApi, type CustomerFollowup } from "./customer-records-api";
import { CustomerViews } from "./customer-views";

const statuses = {
  requested: "Pending",
  human_owned: "With support",
  completed: "Completed",
  withdrawn: "Withdrawn",
} as const;
const statusClass = {
  requested: "new",
  human_owned: "in_progress",
  completed: "closed",
  withdrawn: "withdrawn",
} as const;

export function CustomerFollowupsPage() {
  const { organizationId } = useWorkspace();
  const service = useMemo(() => customerRecordsApi(organizationId), [organizationId]);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [rows, setRows] = useState<CustomerFollowup[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const sequence = useRef(0);
  const queryKey = useMemo(() => new URLSearchParams({
    limit: "30",
    ...(params.get("search") ? { search: params.get("search")! } : {}),
    ...(params.get("status") ? { status: params.get("status")! } : {}),
  }).toString(), [params]);

  useEffect(() => {
    setSearch(params.get("search") ?? "");
    setStatus(params.get("status") ?? "");
  }, [params]);
  useEffect(() => {
    const request = ++sequence.current;
    setRows(null);
    setNext(null);
    setError("");
    setLoadingMore(false);
    void service.followups(new URLSearchParams(queryKey)).then(result => {
      if (request !== sequence.current) return;
      setRows(result.followups);
      setNext(result.nextCursor);
    }).catch(error => {
      if (request !== sequence.current) return;
      setRows([]);
      setError(message(error));
    });
    return () => { sequence.current = request + 1; };
  }, [service, queryKey, refresh]);

  function filter(event: FormEvent) {
    event.preventDefault();
    setParams({ view: "followups", ...(search.trim() ? { search: search.trim() } : {}), ...(status ? { status } : {}) });
  }
  async function loadMore() {
    if (!next || loadingMore) return;
    const request = sequence.current;
    setLoadingMore(true);
    setError("");
    try {
      const query = new URLSearchParams(queryKey);
      query.set("cursor", next);
      const result = await service.followups(query);
      if (request === sequence.current) {
        setRows(current => [...(current ?? []), ...result.followups]);
        setNext(result.nextCursor);
      }
    } catch (error) {
      if (request === sequence.current) setError(message(error));
    } finally {
      if (request === sequence.current) setLoadingMore(false);
    }
  }

  return (
    <section className="workspace-page customer-page min-w-0 space-y-6">
      <header className="customer-page-header flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Customers</h1>
        <Button variant="outline" size="sm" onClick={() => setRefresh(value => value + 1)}>Refresh</Button>
      </header>
      <CustomerViews view="followups" />
      <form className="customer-filters flex flex-wrap items-end gap-3" onSubmit={filter}>
        <label className="block min-w-0 flex-1 basis-48 text-sm">
          <span className="sr-only">Search follow-ups</span>
          <Input aria-label="Search follow-ups" placeholder="Search follow-ups" value={search} maxLength={120} onChange={event => setSearch(event.target.value)} />
        </label>
        <label className="text-sm">
          <span className="sr-only">Status</span>
          <select aria-label="Filter follow-up status" className="task-filter w-full" value={status} onChange={event => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <Button type="submit" variant="outline" size="sm">Filter</Button>
      </form>
      <ErrorMessage value={error} />
      {error ? <Button size="sm" variant="outline" onClick={() => next && rows?.length ? void loadMore() : setRefresh(value => value + 1)}>Try again</Button> : null}
      {rows === null ? <Loading /> : rows.length ? (
        <>
          <div className="customer-table-wrap">
            <table className="customer-table customer-followups-table">
              <thead><tr><th>Customer</th><th>Request</th><th>Status</th><th>Assigned to</th><th>Received</th><th>Conversation</th></tr></thead>
              <tbody>{rows.map(row => (
                <tr key={row.id}>
                  <td data-label="Customer">
                    {row.contactId ? <Link className="customer-record-link" to={`?${new URLSearchParams({ view: "contacts", contact: row.contactId })}`}>{row.name || row.email || row.phone || "Customer"}</Link> : <span>{row.name || row.email || row.phone || "Customer"}</span>}
                    {row.name && row.email ? <span className="customer-followup-line">{row.email}</span> : null}
                    {row.phone && (row.name || row.email) ? <span className="customer-followup-line">{row.phone}</span> : null}
                    {!row.name ? <span className="customer-followup-line">Name not provided</span> : null}
                    {row.preferredTime ? <span className="customer-followup-line">Preferred time: {row.preferredTime}</span> : null}
                  </td>
                  <td data-label="Request">
                    <p className="customer-followup-reason">{row.reason || "Human support requested"}</p>
                    {row.summary && row.summary !== row.reason ? <p className="customer-followup-line">{row.summary}</p> : null}
                    <span className="customer-followup-line">{row.agentName} · <span className="capitalize">{row.channel}</span></span>
                  </td>
                  <td data-label="Status"><span className={`customer-status customer-status-${statusClass[row.status]}`}>{statuses[row.status]}</span></td>
                  <td data-label="Assigned to">{row.assigneeName || "Unassigned"}</td>
                  <td data-label="Received"><time dateTime={row.requestedAt}>{new Date(row.requestedAt).toLocaleString()}</time></td>
                  <td data-label="Conversation"><Link className="customer-followup-conversation" to={`/app/inbox?${new URLSearchParams({ conversation: row.customerConversationId })}`}>Open conversation</Link></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="customer-result-count">{rows.length} shown</p>
            {next ? <Button disabled={loadingMore} variant="outline" size="sm" onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</Button> : null}
          </div>
        </>
      ) : !error ? <p className="customer-empty">No follow-ups</p> : null}
    </section>
  );
}
