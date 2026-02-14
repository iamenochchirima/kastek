import { auth } from "@/auth";

export const metadata = {
  title: "Dashboard | KasiAI",
};

export default async function DashboardPage() {
  const session = await auth();

  return (
    <div>
      <h1 className="mb-2 font-serif text-3xl">
        Welcome back, {session?.user?.name ?? "there"}
      </h1>
      <p className="text-text-muted">Here is your AI business dashboard.</p>
    </div>
  );
}
