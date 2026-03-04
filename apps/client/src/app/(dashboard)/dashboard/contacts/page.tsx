import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import ContactsManager from "@/components/dashboard/contacts/contacts-manager";

export const metadata = {
  title: "Contacts | KasiTek",
};

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const optIn = typeof params.optIn === "string" ? params.optIn : "all";
  const excluded = typeof params.excluded === "string" ? params.excluded : "all";
  const tag = typeof params.tag === "string" ? params.tag.trim() : "";
  const location = typeof params.location === "string" ? params.location.trim() : "";

  const where = {
    userId: session.user.id,
    ...(query
      ? {
          OR: [
            { fullName: { contains: query, mode: "insensitive" as const } },
            { phone: { contains: query, mode: "insensitive" as const } },
            { location: { contains: query, mode: "insensitive" as const } },
            { tags: { has: query } },
          ],
        }
      : {}),
    ...(optIn === "true" ? { optIn: true } : {}),
    ...(optIn === "false" ? { optIn: false } : {}),
    ...(excluded === "true" ? { excluded: true } : {}),
    ...(excluded === "false" ? { excluded: false } : {}),
    ...(tag ? { tags: { has: tag } } : {}),
    ...(location
      ? {
          location: {
            contains: location,
            mode: "insensitive" as const,
          },
        }
      : {}),
  };

  const [contacts, allTags, totalContacts, optedInContacts, excludedContacts] =
    await Promise.all([
      prisma.whatsappContact.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      prisma.whatsappContact.findMany({
        where: { userId: session.user.id },
        select: { tags: true },
      }),
      prisma.whatsappContact.count({
        where: { userId: session.user.id },
      }),
      prisma.whatsappContact.count({
        where: { userId: session.user.id, optIn: true },
      }),
      prisma.whatsappContact.count({
        where: { userId: session.user.id, excluded: true },
      }),
    ]);

  const tagOptions = Array.from(new Set(allTags.flatMap((item) => item.tags))).sort((a, b) =>
    a.localeCompare(b)
  );

  return (
    <ContactsManager
      contacts={contacts.map((contact) => ({
        ...contact,
        optInDate: contact.optInDate?.toISOString() || null,
        lastMarketingSent: contact.lastMarketingSent?.toISOString() || null,
        createdAt: contact.createdAt.toISOString(),
        updatedAt: contact.updatedAt.toISOString(),
      }))}
      filters={{
        q: query,
        optIn,
        excluded,
        tag,
        location,
      }}
      stats={{
        totalContacts,
        optedInContacts,
        excludedContacts,
      }}
      tagOptions={tagOptions}
    />
  );
}
