import { redirect } from "next/navigation";

export default async function LegacyLeadQuotationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/quotations/new?leadId=${id}`);
}
