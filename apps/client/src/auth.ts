import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@/lib/auth-adapter";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

const authSecret =
  process.env.AUTH_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  (process.env.NODE_ENV === "production"
    ? undefined
    : "dev-only-secret-change-this");
const googleClientId =
  process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_CLIENT_ID;
const googleClientSecret =
  process.env.AUTH_GOOGLE_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;

if (!authSecret && process.env.NODE_ENV === "production") {
  throw new Error("Missing AUTH_SECRET/NEXTAUTH_SECRET in production");
}
if ((!googleClientId || !googleClientSecret) && process.env.NODE_ENV === "production") {
  throw new Error("Missing Google OAuth credentials in production");
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(),
  secret: authSecret,

  providers: [
    Google({
      clientId: googleClientId || "",
      clientSecret: googleClientSecret || "",
    }),
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await prisma.user.findUnique({
          where: { email: credentials.email as string },
        });

        if (!user || !user.password) return null;

        const isValid = await bcrypt.compare(
          credentials.password as string,
          user.password
        );

        if (!isValid) return null;

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
        };
      },
    }),
  ],

  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
    error: "/auth-error",
  },

  session: {
    strategy: "database",
  },

  cookies: {
    sessionToken: {
      name: "kasitek_session",
      options: {
        httpOnly: true,
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      },
    },
  },

  callbacks: {
    session: async ({ session, user }) => {
      if (user?.id) {
        session.user.id = user.id;
        session.user.name = user.name ?? "";
        session.user.email = user.email ?? "";
        session.user.image = user.image ?? "";
      }
      return session;
    },
  },
});
