import type { Pool } from "pg";
import type { RequestContext } from "../identity/request-context.js";
import * as bookings from "../services/bookings.js";
export const listBookingServices = (pool: Pool, context: RequestContext) =>
  bookings.listServices(pool, context.organizationId);
export const listBookings = (pool: Pool, context: RequestContext) =>
  bookings.listBookings(pool, context.organizationId);
export const getBooking = (pool: Pool, context: RequestContext, id: string) =>
  bookings.getBooking(pool, context.organizationId, id);
