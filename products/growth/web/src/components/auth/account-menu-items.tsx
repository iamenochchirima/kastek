import { useState } from "react";
import { LockKeyhole, LogOut } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { apiUrl } from "@/lib/server-api";
import { signOut } from "@/lib/shared-login";

export function AccountMenuItems() {
  const [busy, setBusy] = useState(false);
  async function logout(allDevices: boolean) {
    setBusy(true);
    try { await signOut(allDevices); }
    catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not sign out.");
      setBusy(false);
    }
  }
  return (
    <>
      <DropdownMenuItem asChild>
        <a href={apiUrl("/api/auth/account")}><LockKeyhole className="mr-2 size-4" />Account security</a>
      </DropdownMenuItem>
      {[false, true].map((allDevices) => (
        <DropdownMenuItem key={String(allDevices)} disabled={busy} className="text-destructive focus:text-destructive" onSelect={(event) => { event.preventDefault(); void logout(allDevices); }}>
          <LogOut className="mr-2 size-4" />{busy ? "Signing out…" : allDevices ? "Sign out all devices" : "Log out"}
        </DropdownMenuItem>
      ))}
    </>
  );
}
