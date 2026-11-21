import { zodResolver as base } from "@hookform/resolvers/zod";
import type { Resolver } from "react-hook-form";

/** The installed resolver declarations target Zod 4; this app's forms use Zod 3. */
type SchemaLike = { parse: (...args: any[]) => any };

export function zodResolver(schema: SchemaLike, ...args: any[]): Resolver<any> {
  return (base as unknown as (schema: SchemaLike, ...args: any[]) => Resolver<any>)(schema, ...args);
}
