import { api, organizationPath } from "./api";
export type CustomerFields = {
  name?: string;
  email?: string;
  phone?: string;
  service?: string;
  message?: string;
};
export type Contact = {
  id: string;
  revision: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  createdAt: string;
  updatedAt: string;
};
export type CustomerEnquiry = {
  id: string;
  revision: string;
  status: "new" | "in_progress" | "waiting_on_customer" | "closed";
  fields: CustomerFields;
  originalFields?: CustomerFields;
  sourceEnquiryId: string | null;
  sourceTaskId?: string | null;
  channel?: string | null;
  bookings?: Array<{
    id: string;
    state: string;
    startsAt: string;
    endsAt: string;
  }>;
  agentId: string | null;
  conversationId: string | null;
  customerConversationId: string | null;
  contactId: string | null;
  assigneeAccountId: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  activity?: Array<{
    id: string;
    kind: string;
    actorAccountId: string | null;
    body: string | null;
    createdAt: string;
  }>;
};
export type CustomerMember = { accountId: string; name: string; role: string };
export type RecordsPage<T, K extends string> = { [P in K]: T[] } & {
  nextCursor: string | null;
};
export function customerRecordsApi(organizationId: string) {
  const base = `${organizationPath(organizationId)}/customer-records`;
  return {
    enquiries: (query: URLSearchParams) =>
      api<RecordsPage<CustomerEnquiry, "enquiries">>(
        `${base}/enquiries?${query}`,
      ),
    contacts: (query: URLSearchParams) =>
      api<RecordsPage<Contact, "contacts">>(`${base}/contacts?${query}`),
    contact: (id: string) =>
      api<{ contact: Contact; enquiries: CustomerEnquiry[] }>(
        `${base}/contacts/${encodeURIComponent(id)}`,
      ),
    enquiry: (id: string) =>
      api<{ enquiry: CustomerEnquiry }>(
        `${base}/enquiries/${encodeURIComponent(id)}`,
      ),
    activity: (id: string, cursor?: string) =>
      api<{
        activity: NonNullable<CustomerEnquiry["activity"]>;
        nextCursor: string | null;
      }>(
        `${base}/enquiries/${encodeURIComponent(id)}/activity?${new URLSearchParams({ limit: "30", ...(cursor ? { cursor } : {}) })}`,
      ),
    members: () => api<{ members: CustomerMember[] }>(`${base}/members`),
    createEnquiry: (body: unknown) =>
      api<{ enquiry: CustomerEnquiry }>(`${base}/enquiries`, body),
    createContact: (body: unknown) =>
      api<{ contact: Contact }>(`${base}/contacts`, body),
    command: (id: string, body: unknown) =>
      api<{ enquiry: CustomerEnquiry }>(
        `${base}/enquiries/${encodeURIComponent(id)}/commands`,
        body,
      ),
    correctContact: (id: string, body: unknown) =>
      api<{ contact: Contact }>(
        `${base}/contacts/${encodeURIComponent(id)}/commands`,
        body,
      ),
  };
}
