import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({ defaultOptions: { queries: {
  retry: false, staleTime: 0, gcTime: 5 * 60_000, refetchOnWindowFocus: false,
} } });
let scope = 0;
export function requestScope() { return scope; }
export function clearPrivateQueries() {
  scope += 1;
  void queryClient.cancelQueries();
  queryClient.clear();
}
if (typeof window !== "undefined") {
  window.addEventListener("kasitek:business-changing", clearPrivateQueries);
  window.addEventListener("kasitek:session-ended", clearPrivateQueries);
}
