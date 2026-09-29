import { cache } from "react";
import { fetchRustJson } from "@/lib/rust-server-api";

export type RustSessionUser = {
  id: string;
  name: string;
  email: string;
  image: string;
  emailVerified: string | null;
};

export type RustSession = {
  user: RustSessionUser;
};

export const getRustSession = cache(async (): Promise<RustSession | null> => {
  try {
    const payload = await fetchRustJson<{ user?: RustSessionUser }>("/api/auth/me");
    if (!payload.user) {
      return null;
    }

    return {
      user: {
        id: payload.user.id,
        name: payload.user.name ?? "",
        email: payload.user.email ?? "",
        image: payload.user.image ?? "",
        emailVerified: payload.user.emailVerified ?? null,
      },
    };
  } catch {
    return null;
  }
});
