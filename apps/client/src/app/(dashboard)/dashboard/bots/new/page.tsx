import CreateBotWizard from "@/components/dashboard/bots/create-bot-wizard";

export const metadata = {
  title: "Create Bot | KasiTek",
};

export default function NewBotPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Create a new bot</h1>
      <CreateBotWizard />
    </div>
  );
}
