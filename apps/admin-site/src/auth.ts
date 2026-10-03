/**
 * Compatibility shim — replaces NextAuth.
 * All pages that previously called `auth()` get a session-like object
 * backed by the Core admin session cookie instead.
 */
import { getAdminSession } from "@/lib/admin-auth";

export async function auth() {
  const admin = await getAdminSession();
  if (!admin) return null;
  return {
    user: {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
    },
  };
}

// Stub — NextAuth handlers are no longer used.
export const handlers = {
  GET: () => new Response("Not found", { status: 404 }),
  POST: () => new Response("Not found", { status: 404 }),
};

// Stub — logout is handled client-side via /api/core/admin/logout.
export async function signOut() {}
