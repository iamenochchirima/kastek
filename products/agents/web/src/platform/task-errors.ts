const modelErrors: Record<string, string> = {
  MODEL_UNAVAILABLE: "Model unavailable. Choose another model in Configure.",
  MODEL_AUTHENTICATION_FAILED: "Model authentication failed. Ask your administrator to check provider credentials.",
  MODEL_BILLING_REQUIRED: "Model provider credits required. Contact your administrator.",
  MODEL_ACCESS_DENIED: "Model access denied. Choose another model or contact your administrator.",
  MODEL_REQUEST_REJECTED: "Model request rejected. Check the model configuration.",
  MODEL_RATE_LIMITED: "Model rate limit reached. Try again shortly.",
  MODEL_CREDENTIAL_UNAVAILABLE: "Model credentials unavailable. Contact your administrator.",
};

export function taskErrorLabel(code: string): string {
  return modelErrors[code] ?? (code.startsWith("MODEL_") ? "Model call failed. Try again or contact your administrator." : code.replaceAll("_", " ").toLowerCase());
}
