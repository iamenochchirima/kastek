import CreateBotWizard from "@/components/dashboard/bots/create-bot-wizard";

export const metadata = {
  title: "Create Bot | KasiAI",
};

export default function NewBotPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 font-serif text-3xl">Create a new bot</h1>
      <CreateBotWizard />
    </div>
  );
}
