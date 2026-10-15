import {
  useLocation,
  useNavigate,
  useSearchParams as useRouterSearchParams,
} from "react-router-dom";
import { useMemo } from "react";
export function useRouter() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (url: string) => navigate(url),
      replace: (url: string) => navigate(url, { replace: true }),
      back: () => navigate(-1),
    }),
    [navigate],
  );
}
export function usePathname() {
  return useLocation().pathname;
}
export function useSearchParams() {
  return useRouterSearchParams()[0];
}
