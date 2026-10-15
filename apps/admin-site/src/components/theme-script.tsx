import { ACCENTS, APPEARANCE_STORAGE_KEYS, LEGACY_THEME_STORAGE_KEY } from "@/lib/appearance-contract";

const appearanceInitScript = `
(() => {
  const root = document.documentElement;
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const keys = ${JSON.stringify(APPEARANCE_STORAGE_KEYS)};
  const storedTheme = read(keys.theme) || read(${JSON.stringify(LEGACY_THEME_STORAGE_KEY)});
  const themeMode = storedTheme === "light" || storedTheme === "dark" || storedTheme === "system" ? storedTheme : "system";
  const resolvedTheme = themeMode === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : themeMode;
  const accents = ${JSON.stringify(Object.fromEntries(ACCENTS.map(({ id, light, dark }) => [id, { light: [light.base, light.strong, light.soft], dark: [dark.base, dark.strong, dark.soft] }]))) };
  const storedAccent = read(keys.accent);
  const accent = Object.prototype.hasOwnProperty.call(accents, storedAccent) ? storedAccent : "indigo";
  const tokens = accents[accent][resolvedTheme];
  const density = read(keys.density) === "compact" ? "compact" : "comfortable";
  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = themeMode;
  root.dataset.accent = accent;
  root.dataset.density = density;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.classList.toggle("v-reduce-motion", read(keys.reduceMotion) === "1");
  root.classList.toggle("v-hide-live", read(keys.liveIndicators) === "0");
  root.style.setProperty("--brand", tokens[0]);
  root.style.setProperty("--brand-strong", tokens[1]);
  root.style.setProperty("--brand-soft", tokens[2]);
  root.style.setProperty("--appearance-accent", tokens[0]);
  root.style.setProperty("--appearance-accent-strong", tokens[1]);
  root.style.setProperty("--appearance-accent-soft", tokens[2]);
  root.style.setProperty("--chart-1", tokens[0]);
})();
`;

export default function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: appearanceInitScript }} />;
}
