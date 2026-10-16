import { RequestExtractionError } from "./error.js";

export function typedQuery(
  rawUrl: string | undefined,
  fields: readonly string[],
  options: {
    required?: readonly string[];
    signedIntegers?: readonly string[];
    enumValues?: Readonly<Record<string, readonly string[]>>;
    denyUnknown?: boolean;
  } = {},
): Record<string, string | bigint> {
  const result = Object.create(null) as Record<string, string | bigint>,
    accepted = new Set(fields),
    integers = new Set(options.signedIntegers ?? []),
    params = new URLSearchParams(rawUrl?.split("?").slice(1).join("?") ?? "");

  for (const [field, value] of params) {
    if (!accepted.has(field)) {
      if (options.denyUnknown)
        throw new RequestExtractionError(
          `unknown field \`${field}\`, ${expectedFields(fields)}`,
          "query",
        );
      continue;
    }
    if (Object.hasOwn(result, field))
      throw new RequestExtractionError(
        `duplicate field \`${field}\``,
        "query",
      );
    if (integers.has(field)) {
      result[field] = parseI64(value);
    } else {
      const expected = options.enumValues?.[field];
      if (expected && !expected.includes(value))
        throw new RequestExtractionError(
          `unknown variant \`${value}\`, ${expectedValues(expected)}`,
          "query",
        );
      result[field] = value;
    }
  }

  for (const field of options.required ?? []) {
    if (!Object.hasOwn(result, field))
      throw new RequestExtractionError(`missing field \`${field}\``, "query");
  }
  return result;
}

function expectedFields(fields: readonly string[]): string {
  return expectedValues(fields);
}

function expectedValues(values: readonly string[]): string {
  if (values.length === 1) return `expected \`${values[0]}\``;
  if (values.length === 2)
    return `expected \`${values[0]}\` or \`${values[1]}\``;
  return `expected one of ${values.map((value) => `\`${value}\``).join(", ")}`;
}

function parseI64(value: string): bigint {
  if (!/^[-+]?\d+$/.test(value))
    throw new RequestExtractionError(
      value
        ? "invalid digit found in string"
        : "cannot parse integer from empty string",
      "query",
    );
  const parsed = BigInt(value);
  if (parsed < -(1n << 63n))
    throw new RequestExtractionError(
      "number too small to fit in target type",
      "query",
    );
  if (parsed >= 1n << 63n)
    throw new RequestExtractionError(
      "number too large to fit in target type",
      "query",
    );
  return parsed;
}
