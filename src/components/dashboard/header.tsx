import SignOutButton from "@/components/auth/sign-out-button";

interface DashboardHeaderProps {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
}

export default function DashboardHeader({ user }: DashboardHeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-border px-8 py-4 max-sm:px-4">
      <div />
      <div className="flex items-center gap-4">
        <div className="text-right">
          <div className="text-sm font-medium text-text">
            {user.name ?? user.email}
          </div>
          {user.name && (
            <div className="text-xs text-text-dim">{user.email}</div>
          )}
        </div>
        {user.image && (
          <img
            src={user.image}
            alt=""
            className="h-8 w-8 rounded-full border border-border"
          />
        )}
        <SignOutButton />
      </div>
    </header>
  );
}
