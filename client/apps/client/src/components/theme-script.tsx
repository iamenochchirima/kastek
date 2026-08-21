const appearanceInitScript = `
(() => {
  const root = document.documentElement;
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const storedTheme = read("kasitek-theme");
  const themeMode = storedTheme === "light" || storedTheme === "dark" || storedTheme === "system" ? storedTheme : "system";
  const resolvedTheme = themeMode === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : themeMode;
  const accents = {
    indigo: { light: ["#5B5BF0", "#4A46E8", "rgba(91, 91, 240, 0.10)"], dark: ["#818CF8", "#6366F1", "rgba(129, 140, 248, 0.12)"] },
    violet: { light: ["#8B5CF6", "#7C3AED", "rgba(139, 92, 246, 0.10)"], dark: ["#A78BFA", "#8B5CF6", "rgba(167, 139, 250, 0.12)"] },
    cyan: { light: ["#0EA5E9", "#0284C7", "rgba(14, 165, 233, 0.10)"], dark: ["#38BDF8", "#0EA5E9", "rgba(56, 189, 248, 0.12)"] },
    emerald: { light: ["#10B981", "#059669", "rgba(16, 185, 129, 0.10)"], dark: ["#34D399", "#10B981", "rgba(52, 211, 153, 0.12)"] },
    rose: { light: ["#F43F5E", "#E11D48", "rgba(244, 63, 94, 0.10)"], dark: ["#FB7185", "#F43F5E", "rgba(251, 113, 133, 0.12)"] }
  };
  const storedAccent = read("kasitek-accent");
  const accent = Object.prototype.hasOwnProperty.call(accents, storedAccent) ? storedAccent : "indigo";
  const tokens = accents[accent][resolvedTheme];
  const density = read("kasitek-density") === "compact" ? "compact" : "comfortable";
  const rootStyle = root.style;
  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = themeMode;
  root.dataset.accent = accent;
  root.dataset.density = density;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.classList.toggle("v-reduce-motion", read("kasitek-pref-reduce-motion") === "1");
  root.classList.toggle("v-hide-live", read("kasitek-pref-live-indicators") === "0");
  rootStyle.setProperty("--brand", tokens[0]);
  rootStyle.setProperty("--brand-strong", tokens[1]);
  rootStyle.setProperty("--brand-soft", tokens[2]);
  rootStyle.setProperty("--appearance-accent", tokens[0]);
  rootStyle.setProperty("--appearance-accent-strong", tokens[1]);
  rootStyle.setProperty("--appearance-accent-soft", tokens[2]);
  rootStyle.setProperty("--chart-1", tokens[0]);
})();
`;

export default function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: appearanceInitScript }} />;
}
