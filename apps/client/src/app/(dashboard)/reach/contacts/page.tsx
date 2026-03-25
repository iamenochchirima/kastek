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

  const search = new URLSearchParams();
  if (query) search.set("q", query);
  if (optIn && optIn !== "all") search.set("optIn", optIn);
  if (excluded && excluded !== "all") search.set("excluded", excluded);
  if (tag) search.set("tag", tag);
  if (location) search.set("location", location);

  const contactsResponse = await fetchRustJson<{
    contacts: Array<{
      id: string;
      phone: string;
      fullName: string | null;
      tags: string[];
      location: string | null;
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
    stats: {
      totalContacts: number;
      optedInContacts: number;
      excludedContacts: number;
    };
  }>(`/api/whatsapp/contacts${search.toString() ? `?${search.toString()}` : ""}`);

  return (
    <ContactsManager
      contacts={contactsResponse.contacts}
      filters={{
        q: query,
        optIn,
        excluded,
        tag,
        location,
      }}
      stats={contactsResponse.stats}
      tagOptions={contactsResponse.tagOptions}
    />
  );
}
