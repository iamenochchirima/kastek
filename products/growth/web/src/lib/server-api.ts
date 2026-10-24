// Browser requests always use the Growth origin. The server owns API routing.
export function getApiBaseUrl() { return ""; }
export function apiUrl(path: string) { return path.startsWith("/") ? path : `/${path}`; }
