export function decodeContentResult<T>(encoded: string): T {
  const response = JSON.parse(encoded) as {
    state?: string;
    result?: T;
    error?: { message?: string } | string;
  };
  if (response.state !== "succeeded")
    throw new Error(
      typeof response.error === "string"
        ? response.error
        : response.error?.message || "The request did not complete.",
    );
  if (!Object.hasOwn(response, "result"))
    throw new Error("The response is missing its result.");
  return response.result as T;
}
