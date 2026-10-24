import { useState } from "react";
import { LogOut } from "lucide-react";
import { signOut } from "@/lib/shared-login";
import { Button } from "@/components/ui/button";

export default function SignOutButton({ allDevices = false }: { allDevices?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function logout() {
    setBusy(true);
    setError("");
    try { await signOut(allDevices); }
    catch { setError("Could not sign out. Please try again."); setBusy(false); }
  }
  return (
    <div className="space-y-2">
      <Button disabled={busy} onClick={() => void logout()} variant="outline"><LogOut className="size-4" />{busy ? "Signing out…" : allDevices ? "Sign out all devices" : "Log out"}</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
