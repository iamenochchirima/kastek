import { fetchRustJson } from "@/lib/rust-server-api";

export type ProductTourStatus = {
  shouldShow: boolean;
  currentStep: number;
  primaryGoal: string | null;
};

export function fetchProductTourStatus() {
  return fetchRustJson<ProductTourStatus>("/api/product-tour");
}
