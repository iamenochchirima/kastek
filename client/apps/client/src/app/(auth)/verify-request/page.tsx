import { VerifyEmailRequest } from "./verify-email-request";

export const metadata = {
  title: "Check Your Email | KasiTek",
};

export default async function VerifyRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; verified?: string }>;
}) {
  const { email, verified } = await searchParams;
  return <VerifyEmailRequest initialEmail={email ?? ""} verified={verified === "true"} />;
}
