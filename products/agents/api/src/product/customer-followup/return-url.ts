import { z } from "zod";

export function customerReturnUrl(publicUrl: string, deploymentId: string, secret: string): string {
  const origin = new URL(publicUrl);
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid Agents public URL");
  const url = new URL(`/support/return/${z.uuid().parse(deploymentId)}`, origin);
  url.hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(secret);
  return url.href;
}
