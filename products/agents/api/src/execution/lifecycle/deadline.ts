/** An absent work deadline never removes the finite deadline on an individual operation. */
export function deadlineMillis(value: Date | string | null | undefined): number {
  return value == null ? Number.POSITIVE_INFINITY : new Date(value).getTime();
}
