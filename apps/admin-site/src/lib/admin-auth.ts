import {adminSessionTransport,loadAdminActor} from "./admin-session-transport";
import { adminServiceHeaders } from "./admin-service-auth";
import { adminCapabilities, requiredAdminCapability } from "@kasitek-labs/server-support/admin-authority";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const CORE_BACKEND_URL =
  process.env.CORE_BACKEND_URL ?? "http://localhost:4000";
const TENANTS_BACKEND_URL =
  process.env.TENANTS_BACKEND_URL ?? "http://localhost:8090";
const ADMIN_SESSION_COOKIE = "kasitek_admin_session";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

function unavailableJsonResponse(service: string, error: unknown): Response {
  const message =
    error instanceof Error ? error.message : "Unable to reach upstream service";

  return new Response(
    JSON.stringify({
      error: `${service} is unavailable`,
      detail: message,
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

/**
 * Reads the admin session from the Core API.
 * Returns null if not authenticated.
 * Must only be called from Server Components / Route Handlers.
 */
export async function getAdminSession(): Promise<AdminUser | null> {
  try {const transport=adminSessionTransport();return await loadAdminActor((await cookies()).get(transport.cookie)?.value);} catch {return null;}
}

/**
 * Like getAdminSession but redirects to /login if not authenticated.
 */
export async function requireAdminSession(): Promise<AdminUser> {
  const admin = await getAdminSession();
  if (!admin) redirect("/login");
  return admin;
}

/**
 * Fetches from the Core API, forwarding the session cookie.
 * Use inside Server Components (no Request object needed).
 */
export async function fetchFromCore(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(ADMIN_SESSION_COOKIE);
  const cookieHeader = sessionCookie
    ? `${ADMIN_SESSION_COOKIE}=${sessionCookie.value}`
    : "";

  const headers = new Headers(init?.headers);
  if (cookieHeader) headers.set("Cookie", cookieHeader);
  else headers.delete("Cookie");
  headers.set("Origin", process.env.ADMIN_FRONTEND_URL ?? "http://localhost:3001");
  if(process.env.OPS_BACKEND_URL){
    const actor=await getAdminSession();if(!actor)return Response.json({error:"Unauthorized"},{status:401});
    const method=init?.method??"GET",body=typeof init?.body==="string"?init.body:"";
    if(!adminCapabilities(actor.role).has(requiredAdminCapability(method,path)))return Response.json({error:"Forbidden"},{status:403});
    headers.delete("Cookie");for(const [key,value]of Object.entries(adminServiceHeaders(actor,"growth",method,path,body)))headers.set(key,value);
  }
  return fetch(`${CORE_BACKEND_URL}${path}`, {...init, headers, cache: "no-store"});
}

/**
 * Fetches from the Agency API with request-bound service and actor authority.
 * Use inside Server Components.
 */
export async function fetchFromTenants(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const actor = await getAdminSession();
  if (!actor) return new Response(JSON.stringify({error: "Unauthorized"}), {status: 401});
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : "";
  if (!adminCapabilities(actor.role).has(requiredAdminCapability(method, path))) return new Response(JSON.stringify({error: "Forbidden"}), {status: 403});
  try {
    const authorityHeaders = adminServiceHeaders(actor, "agency", method, path, body);
    return await fetch(`${TENANTS_BACKEND_URL}${path}`, {...init, headers: {...Object.fromEntries(new Headers(init?.headers)), ...authorityHeaders}, cache: "no-store"});
  } catch (error) { return unavailableJsonResponse("Agency backend", error); }
}

/**
 * Proxies a request to the Core API, forwarding the session cookie.
 * Use inside Next.js Route Handlers.
 */
export async function proxyToCore(
  req: Request,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(ADMIN_SESSION_COOKIE);
  const cookieHeader = sessionCookie
    ? `${ADMIN_SESSION_COOKIE}=${sessionCookie.value}`
    : "";

  const url = new URL(req.url);
  const target = `${CORE_BACKEND_URL}${path}${url.search}`;
  const idempotencyKey = req.headers.get("idempotency-key");
  const correlationId = req.headers.get("x-correlation-id");

  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (cookieHeader) headers.set("Cookie", cookieHeader);
  else headers.delete("Cookie");
  headers.set("Origin", process.env.ADMIN_FRONTEND_URL ?? "http://localhost:3001");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (correlationId) headers.set("X-Correlation-Id", correlationId);
  const body=req.method!=="GET"&&req.method!=="HEAD"?await req.text():undefined;
  if(process.env.OPS_BACKEND_URL){
    const actor=await getAdminSession();if(!actor)return Response.json({error:"Unauthorized"},{status:401});
    if(!adminCapabilities(actor.role).has(requiredAdminCapability(req.method,path+url.search)))return Response.json({error:"Forbidden"},{status:403});
    headers.delete("Cookie");for(const [key,value]of Object.entries(adminServiceHeaders(actor,"growth",req.method,path+url.search,body??"")))headers.set(key,value);
  }
  return fetch(target, {...init,method:req.method,signal:req.signal,headers,body,cache:"no-store"});
}

/**
 * Proxies to Agency with request-bound service and actor authority.
 */
export async function proxyToTenants(
  req: Request,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const actor = await getAdminSession();
  if (!actor) return new Response(JSON.stringify({error: "Unauthorized"}), {status: 401});
  const method = req.method;
  const targetPath = path + new URL(req.url).search;
  if (!adminCapabilities(actor.role).has(requiredAdminCapability(method, targetPath))) return new Response(JSON.stringify({error: "Forbidden"}), {status: 403});
  const body = !["GET", "HEAD"].includes(method) ? await req.text() : "";
  try {
    const authorityHeaders = adminServiceHeaders(actor, "agency", method, targetPath, body);
    return await fetch(`${TENANTS_BACKEND_URL}${targetPath}`, {...init, method, headers: {"Content-Type": "application/json", ...authorityHeaders}, ...(body ? {body} : {}), cache: "no-store"});
  } catch (error) { return unavailableJsonResponse("Agency backend", error); }
}
