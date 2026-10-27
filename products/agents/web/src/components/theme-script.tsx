import { ACCENTS, APPEARANCE_STORAGE_KEYS } from "@/lib/appearance-contract";

const bootstrapAccents = Object.fromEntries(
  ACCENTS.map(({ id, light, dark }) => [
    id,
    {
      light: [light.base, light.strong, light.soft],
      dark: [dark.base, dark.strong, dark.soft],
    },
  ]),
);

const appearanceInitScript = `
(() => {
  const root = document.documentElement;
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const keys = ${JSON.stringify(APPEARANCE_STORAGE_KEYS)};
  const storedTheme = read(keys.theme);
  const themeMode = storedTheme === "light" || storedTheme === "dark" || storedTheme === "system" ? storedTheme : "system";
  const resolvedTheme = themeMode === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : themeMode;
  const accents = ${JSON.stringify(bootstrapAccents)};
  const storedAccent = read(keys.accent);
  // Indigo was the previous application default. No accent picker currently exists;
  // retain other stored preferences while moving that legacy default to blue.
  const accent = storedAccent === "indigo" ? "blue" : Object.prototype.hasOwnProperty.call(accents, storedAccent) ? storedAccent : "blue";
  const tokens = accents[accent][resolvedTheme];
  const density = read(keys.density) === "compact" ? "compact" : "comfortable";
  const rootStyle = root.style;
  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = themeMode;
  root.dataset.accent = accent;
  root.dataset.density = density;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.classList.toggle("v-reduce-motion", read(keys.reduceMotion) === "1");
  root.classList.toggle("v-hide-live", read(keys.liveIndicators) === "0");
  rootStyle.setProperty("--brand", tokens[0]);
  rootStyle.setProperty("--brand-strong", tokens[1]);
  rootStyle.setProperty("--brand-soft", tokens[2]);
  rootStyle.setProperty("--appearance-accent", tokens[0]);
  rootStyle.setProperty("--appearance-accent-strong", tokens[1]);
  rootStyle.setProperty("--appearance-accent-soft", tokens[2]);
  rootStyle.setProperty("--chart-1", tokens[0]);
})();
`;

function applyAppearance() {
  const script = document.createElement("script"); script.textContent = appearanceInitScript; document.head.append(script); script.remove();
}
let listening = false;
export function bootstrapAppearance() {
  applyAppearance();
  if (listening) return;
  listening = true;
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (document.documentElement.dataset.themeMode === "system") applyAppearance();
  });
}
