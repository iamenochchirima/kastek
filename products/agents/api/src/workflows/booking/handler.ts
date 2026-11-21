import { PlatformError } from "../../contracts/contracts";
import type { TaskOutcome } from "../../contracts/execution";
import type { CapabilityOperationHandler } from "../../execution/capabilities/operation-handlers";
import type { BookingService } from "./bookings";
import { awaitBookingConfirmation } from "./confirmation";

/**
 * Booking operations run through the same durable confirmation and invocation path as other
 * capability handlers instead of a booking-specific branch in the business loop.
 */
export function bookingOperationHandler(bookings?: BookingService): CapabilityOperationHandler {
  function service(): BookingService {
    if (!bookings) throw new PlatformError("BOOKING_PROVIDER_UNAVAILABLE", 503, "Booking is unavailable");
    return bookings;
  }
  return {
    capability: "tools",
    operations: ["booking.availability", "booking.reserve"],
    async confirm(call): Promise<TaskOutcome | undefined> {
      if (call.operation !== "booking.reserve") return undefined;
      return awaitBookingConfirmation(call.ctx, call.pool, service(), call.taskId, call.operationId,
        (call.arguments as { start: string }).start);
    },
    async invoke(call) {
      const args = call.arguments as { start: string; end: string };
      return call.operation === "booking.availability"
        ? service().availability(call.taskId, call.operationId, args, call.signal)
        : service().execute(call.taskId, call.operationId, args.start, call.signal);
    },
  };
}
