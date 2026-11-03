import { Link } from "react-router-dom";

export function CustomerViews({ view }: { view: "enquiries" | "contacts" | "followups" }) {
  return (
    <nav aria-label="Customer views" className="customer-tabs flex border-b gap-5">
      {([
        ["enquiries", "Enquiries", "?"],
        ["contacts", "Contacts", "?view=contacts"],
        ["followups", "Follow-ups", "?view=followups"],
      ] as const).map(([value, label, href]) => (
        <Link
          key={value}
          aria-current={view === value ? "page" : undefined}
          className={`pb-3 text-sm ${view === value ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
          to={href}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
