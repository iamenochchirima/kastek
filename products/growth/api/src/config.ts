export interface CoreConfig {
  port: number;
  environment: string;
  databaseUrl: string;
  databaseMaxConnections: number;
  frontendUrl: string;
  adminFrontendUrl: string;
  publicApiUrl: string;
  mediaStoragePath: string;
  env: Record<string, string | undefined>;
  rawEnv: Record<string, string | undefined>;
}

/** SQLx's unsigned env parser falls back on invalid input rather than clamping it. */
function unsigned(value: string | undefined, fallback: number, maximum: number): number {
  if (!value || !/^\+?\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : fallback;
}

function origin(value: string, name: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an absolute HTTP(S) origin without a path`);
  }
  return url.origin;
}

export function readConfig(source: Record<string, string | undefined> = process.env): CoreConfig {
  const env = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value?.trim() || undefined]));
  const environment = env.ENVIRONMENT ?? 'development';
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return {
    port: unsigned(env.PORT, 4000, 65_535),
    environment,
    databaseUrl,
    databaseMaxConnections: unsigned(env.DATABASE_MAX_CONNECTIONS, 10, 4_294_967_295),
    frontendUrl: origin(env.FRONTEND_URL ?? 'http://localhost:3000', 'FRONTEND_URL'),
    adminFrontendUrl: env.ADMIN_FRONTEND_URL ?? (environment.toLowerCase() === 'production'
      ? 'https://admin.kasitek.co.za' : 'http://localhost:3001'),
    publicApiUrl: origin(env.KASITEK_CORE_PUBLIC_URL ?? 'http://localhost:4000', 'KASITEK_CORE_PUBLIC_URL'),
    mediaStoragePath: env.KASITEK_MEDIA_STORAGE_PATH ?? '.data/media',
    env,
    rawEnv: { ...source },
  };
}
