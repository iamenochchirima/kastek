export type TemplateCategoryValue = "MARKETING" | "UTILITY" | "AUTHENTICATION";

export type TemplateLibraryItem = {
  id: string;
  title: string;
  category: TemplateCategoryValue;
  description: string;
  header?: string;
  body: string;
  footer?: string;
};

export const TEMPLATE_CATEGORY_OPTIONS: Array<{
  value: TemplateCategoryValue;
  label: string;
  badge: string;
  description: string;
}> = [
  {
    value: "MARKETING",
    label: "Marketing",
    badge: "Promotions",
    description: "Offers, announcements, launch campaigns, and re-engagement outreach.",
  },
  {
    value: "UTILITY",
    label: "Utility",
    badge: "Notifications",
    description: "Order updates, reminders, confirmations, and expected service notifications.",
  },
  {
    value: "AUTHENTICATION",
    label: "Authentication",
    badge: "Verification",
    description: "One-time passwords, verification steps, and secure login messages.",
  },
];

export const TEMPLATE_LIBRARY: TemplateLibraryItem[] = [
  {
    id: "marketing-launch",
    title: "Product Launch",
    category: "MARKETING",
    description: "Announce a new product or offer with one personalized slot.",
    header: "KasiAI Update",
    body: "Hi {{1}}, our new launch is live. Tap into the offer before it ends.",
    footer: "Reply STOP to unsubscribe",
  },
  {
    id: "marketing-promo",
    title: "Limited Offer",
    category: "MARKETING",
    description: "Short promotional burst for an active audience.",
    header: "Special offer",
    body: "Hi {{1}}, you qualify for our latest special. Reply to learn more.",
    footer: "Valid for a limited time",
  },
  {
    id: "utility-reminder",
    title: "Appointment Reminder",
    category: "UTILITY",
    description: "Simple reminder for a scheduled booking or appointment.",
    header: "Upcoming reminder",
    body: "Hi {{1}}, this is a reminder for your booking on {{2}}.",
    footer: "Reply if you need to reschedule",
  },
  {
    id: "utility-confirmation",
    title: "Order Confirmation",
    category: "UTILITY",
    description: "Confirm a transaction or request the user expects.",
    header: "Order confirmed",
    body: "Hi {{1}}, your order {{2}} has been confirmed and is being processed.",
    footer: "We will send another update soon",
  },
  {
    id: "auth-otp",
    title: "OTP Verification",
    category: "AUTHENTICATION",
    description: "One-time passcode for login or verification.",
    header: "Verification code",
    body: "Your KasiAI verification code is {{1}}. It expires in {{2}} minutes.",
    footer: "Do not share this code",
  },
  {
    id: "auth-login",
    title: "Login Challenge",
    category: "AUTHENTICATION",
    description: "Secure sign-in confirmation for the account owner.",
    header: "Secure sign-in",
    body: "Use {{1}} to complete your sign-in request on KasiAI.",
    footer: "Ignore if this was not you",
  },
];

export function categoryLabel(category: TemplateCategoryValue) {
  return TEMPLATE_CATEGORY_OPTIONS.find((option) => option.value === category)?.label || category;
}
