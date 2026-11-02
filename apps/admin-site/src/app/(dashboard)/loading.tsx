export default function AdminLoading() {
  return <div className="admin-page animate-pulse" role="status" aria-label="Loading page"><div className="h-8 w-48 rounded bg-secondary" /><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((item) => <div key={item} className="h-24 rounded bg-secondary" />)}</div><div className="h-72 rounded bg-secondary" /></div>;
}
