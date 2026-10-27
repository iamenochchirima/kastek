import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

/** The server reports binding availability using the same rules as reply admission. */
export function InboxChannelAvailability({ available }: { available?: boolean }) {
  if (available !== false) return null;
  return <div role="status" className="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-sm">
    Channel unavailable. Reconnect or resume the channel to send replies.
  </div>;
}

export function InboxCustomerRecord({ contactId }: { contactId?: string | null }) {
  return contactId
    ? <Button asChild variant="outline" size="sm" className="mt-4"><Link to={`/app/customers?view=contacts&contact=${encodeURIComponent(contactId)}`}>View customer</Link></Button>
    : <p className="mt-4 text-sm text-muted-foreground">Customer record unavailable</p>;
}
