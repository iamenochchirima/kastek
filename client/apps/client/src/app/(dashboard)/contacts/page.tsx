import ContactsManager from "@/components/dashboard/contacts/contacts-manager";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Contacts | KasiTek",
};

export default async function ReachContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const optIn = typeof params.optIn === "string" ? params.optIn : "all";
  const excluded = typeof params.excluded === "string" ? params.excluded : "all";
  const tag = typeof params.tag === "string" ? params.tag.trim() : "";
  const location = typeof params.location === "string" ? params.location.trim() : "";
  const listLabel = typeof params.listLabel === "string" ? params.listLabel.trim() : "";

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
    };
  };

  const baseSearch = new URLSearchParams();
  if (listLabel) baseSearch.set("listLabel", listLabel);

  const searchSearch = new URLSearchParams();
  if (query) searchSearch.set("q", query);
  if (optIn && optIn !== "all") searchSearch.set("optIn", optIn);
  if (excluded && excluded !== "all") searchSearch.set("excluded", excluded);
  if (tag) searchSearch.set("tag", tag);
  if (location) searchSearch.set("location", location);

  const [contactsResponse, searchResponse] = await Promise.all([
    fetchRustJson<ContactsResponse>(`/api/whatsapp/contacts${baseSearch.toString() ? `?${baseSearch.toString()}` : ""}`),
    query
      ? fetchRustJson<ContactsResponse>(`/api/whatsapp/contacts?${searchSearch.toString()}`)
      : Promise.resolve(null),
  ]);

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
      }}
      lists={contactsResponse.lists ?? []}
      searchResults={searchResponse?.contacts ?? []}
      stats={contactsResponse.stats ?? { totalContacts: 0, optedInContacts: 0, excludedContacts: 0 }}
    />
  );
}
