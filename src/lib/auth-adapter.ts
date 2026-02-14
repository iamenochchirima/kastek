import type { Adapter, AdapterUser } from "next-auth/adapters";
import { prisma } from "@/lib/prisma";

function toAdapterUser(user: {
  id: string;
  name: string | null;
  email: string | null;
  emailVerified: Date | null;
  image: string | null;
}): AdapterUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email ?? "",
    emailVerified: user.emailVerified,
    image: user.image,
  };
}

export function PrismaAdapter(): Adapter {
  return {
    async createUser(data) {
      const user = await prisma.user.create({
        data: {
          email: data.email,
          name: data.name,
          image: data.image,
          emailVerified: data.emailVerified,
        },
      });
      return toAdapterUser(user);
    },

    async getUser(id) {
      const user = await prisma.user.findUnique({ where: { id } });
      return user ? toAdapterUser(user) : null;
    },

    async getUserByEmail(email) {
      const user = await prisma.user.findUnique({ where: { email } });
      return user ? toAdapterUser(user) : null;
    },

    async getUserByAccount({ provider, providerAccountId }) {
      const account = await prisma.account.findFirst({
        where: { provider, providerAccountId },
        include: { user: true },
      });
      return account?.user ? toAdapterUser(account.user) : null;
    },

    async updateUser({ id, ...data }) {
      const user = await prisma.user.update({ where: { id }, data });
      return toAdapterUser(user);
    },

    async deleteUser(id) {
      await prisma.user.delete({ where: { id } });
    },

    async linkAccount(data) {
      await prisma.account.create({ data });
    },

    async unlinkAccount({ provider, providerAccountId }) {
      await prisma.account.deleteMany({
        where: { provider, providerAccountId },
      });
    },

    async createSession(data) {
      return prisma.session.create({ data });
    },

    async getSessionAndUser(sessionToken) {
      const session = await prisma.session.findUnique({
        where: { sessionToken },
        include: { user: true },
      });
      if (!session) return null;
      const { user, ...rest } = session;
      return { session: rest, user: toAdapterUser(user) };
    },

    async updateSession({ sessionToken, ...data }) {
      return prisma.session.update({
        where: { sessionToken },
        data,
      });
    },

    async deleteSession(sessionToken) {
      await prisma.session.delete({ where: { sessionToken } });
    },

    async createVerificationToken(data) {
      return prisma.verificationToken.create({ data });
    },

    async useVerificationToken({ identifier, token }) {
      const vt = await prisma.verificationToken.findFirst({
        where: { identifier, token },
      });
      if (!vt) return null;
      await prisma.verificationToken.delete({
        where: { identifier_token: { identifier, token } },
      });
      return vt;
    },
  };
}
