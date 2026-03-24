export function getRequiredSocialEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

export function getSocialAppUrl() {
  const value = process.env.AUTH_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!value) {
    throw new Error("AUTH_URL or NEXT_PUBLIC_APP_URL is required for social OAuth");
  }

  return value.replace(/\/$/, "");
}
