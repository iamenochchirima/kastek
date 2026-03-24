import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

export type RustSessionUser = {
  id: string;
  name: string;
  email: string;
  image: string;
};

export type RustSession = {
  user: RustSessionUser;
};

const SESSION_COOKIE = "kasitek_session";

export async function getRustSession(): Promise<RustSession | null> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionToken) return null;

  const session = await prisma.session.findUnique({
    where: { sessionToken },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
        },
      },
    },
  });

  if (!session || session.expires <= new Date()) {
    return null;
  }

  return {
    user: {
      id: session.user.id,
      name: session.user.name ?? "",
      email: session.user.email ?? "",
      image: session.user.image ?? "",
    },
  };
}
