import { fetchCoreJson } from "@/lib/core-server-api";

export type ProductTourStatus = {
  shouldShow: boolean;
  currentStep: number;
  primaryGoal: string | null;
};

export function fetchProductTourStatus() {
  return fetchCoreJson<ProductTourStatus>("/api/product-tour");
}
