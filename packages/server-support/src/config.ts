export const envOptional = (name: string): string | undefined =>
  process.env[name]?.trim();
export function envRequired(name: string): string {
  const value = envOptional(name);
  if (!value) throw new Error(`missing environment variable: ${name}`);
  return value;
}
export const envStringOr = (name: string, fallback: string): string =>
  envOptional(name) || fallback;
function unsigned(name: string, fallback: number, max: number): number {
  const value = envOptional(name);
  if (!value || !/^\+?\d+$/.test(value)) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n <= max ? n : fallback;
}
export const envU16Or = (name: string, fallback: number): number =>
  unsigned(name, fallback, 65535);
export const envU32Or = (name: string, fallback: number): number =>
  unsigned(name, fallback, 4294967295);
export const envCsv = (name: string): string[] =>
  (envOptional(name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
export const envTruthy = (name: string): boolean =>
  ["1", "true", "yes", "on"].includes((envOptional(name) ?? "").toLowerCase());
export const environmentAllowsLoopbackOrigins = (
  environment: string,
): boolean =>
  ["development", "dev", "local", "test"].includes(
    environment.trim().toLowerCase(),
  );
export function normalizeHttpOrigin(value: string): string | undefined {
  try {
    const u = new URL(value.trim());
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash
      ? u.origin
      : undefined;
  } catch {
    return undefined;
  }
}
export function isLoopbackOrigin(value: string): boolean {
  const origin = normalizeHttpOrigin(value);
  if (!origin) return false;
  const host = new URL(origin).hostname;
  return (
    host === "localhost" ||
    host === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}
