/** Browser API requests use the same origin. Development and production proxy /api. */
export function getApiBaseUrl() { return ""; }
export function apiUrl(path: string) { return path.startsWith("/") ? path : `/${path}`; }
