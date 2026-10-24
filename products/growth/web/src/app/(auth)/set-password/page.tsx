import { redirectDocument } from "react-router";

export function clientLoader() {
  throw redirectDocument("/api/auth/account");
}

export default function AccountPage() { return null; }
