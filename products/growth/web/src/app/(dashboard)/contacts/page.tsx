import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import ContactsManager from "@/components/dashboard/contacts/contacts-manager";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson } from "@/lib/core-server-api";
import { redirect } from "react-router";

export function meta() { return [{ title: "Contacts | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const search = new URL(route.request.url).searchParams;
  const searchParams = (Object.fromEntries([...search.keys()].map(key => [key, search.getAll(key).length > 1 ? search.getAll(key) : search.get(key)!])) as Record<string, string | string[] | undefined>);

  const session = await getWorkspaceSession(route.request);
  if (!session?.user?.id) throw redirect("/login");

  const params = searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const optIn = typeof params.optIn === "string" ? params.optIn : "all";
  const excluded = typeof params.excluded === "string" ? params.excluded : "all";
  const tag = typeof params.tag === "string" ? params.tag.trim() : "";
  const location = typeof params.location === "string" ? params.location.trim() : "";
  const listLabel = typeof params.listLabel === "string" ? params.listLabel.trim() : "";
  const requestedPage = typeof params.page === "string" ? Number(params.page) : 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 100000) : 1;

  type ContactsResponse = {
    contacts: Array<{
      id: string;
      contactId: string;
      customerId: string | null;
      phone: string;
      fullName: string | null;
      tags: string[];
      location: string | null;
      listLabel: string;
      metadata: Record<string, string> | null;
      optIn: boolean;
      optInSource: string | null;
      optInDate: string | null;
      lastMarketingSent: string | null;
      excluded: boolean;
      notes: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    tagOptions: string[];
    lists: Array<{
      label: string;
      totalContacts: number;
      primaryLocation: string | null;
      metadataKeys: string[];
    }>;
    stats: {
      totalContacts: number;
      optedInContacts: number;
      excludedContacts: number;
      filteredTotal?: number;
    };
  };

  const baseSearch = new URLSearchParams({ limit: "50", cursor: String((page - 1) * 50) });
  if (listLabel) baseSearch.set("listLabel", listLabel);
  if (optIn && optIn !== "all") baseSearch.set("optIn", optIn);
  if (excluded && excluded !== "all") baseSearch.set("excluded", excluded);
  if (tag) baseSearch.set("tag", tag);
  if (location) baseSearch.set("location", location);

  const searchSearch = new URLSearchParams(baseSearch);
  if (query) searchSearch.set("q", query);
  if (optIn && optIn !== "all") searchSearch.set("optIn", optIn);
  if (excluded && excluded !== "all") searchSearch.set("excluded", excluded);
  if (tag) searchSearch.set("tag", tag);
  if (location) searchSearch.set("location", location);

  const [contactsResponse, searchResponse] = await Promise.all([
    fetchCoreJson<ContactsResponse>(`/api/whatsapp/contacts${baseSearch.toString() ? `?${baseSearch.toString()}` : ""}`),
    query
      ? fetchCoreJson<ContactsResponse>(`/api/whatsapp/contacts?${searchSearch.toString()}`)
      : Promise.resolve(null),
  ]);

  return { query, optIn, excluded, tag, location, listLabel, page, contactsResponse, searchResponse };
}

export default function ReachContactsPage() {
  const { query, optIn, excluded, tag, location, listLabel, page, contactsResponse, searchResponse } = useLoaderData<typeof clientLoader>();
  return (
    <ContactsManager
      contacts={contactsResponse.contacts ?? []}
      filters={{
        q: query,
        optIn,
        excluded,
        tag,
        location,
        listLabel,
        page,
      }}
      lists={contactsResponse.lists ?? []}
      searchResults={searchResponse?.contacts ?? []}
      stats={{ ...(contactsResponse.stats ?? { totalContacts: 0, optedInContacts: 0, excludedContacts: 0 }), filteredTotal: searchResponse?.stats?.filteredTotal ?? contactsResponse.stats?.filteredTotal }}
    />
  );
}
