import type { ClientLoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export function meta() { return [{ title: "Billing and Usage | KasiTek" }]; }

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const search = new URL(route.request.url).searchParams;
  const searchParams = (Object.fromEntries([...search.keys()].map(key => [key, search.getAll(key).length > 1 ? search.getAll(key) : search.get(key)!])) as { payment?: string; reference?: string; trxref?: string });

  const query = searchParams;
  const params = new URLSearchParams({ section: "billing" });
  for (const key of ["payment", "reference", "trxref"] as const) {
    if (query[key]) params.set(key, query[key]!);
  }
  throw redirect(`/workspace/settings?${params.toString()}`);

}

export default function BillingPage() { return null; }
