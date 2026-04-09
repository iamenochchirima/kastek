const themeInitScript = `
(() => {
  const storageKey = "kasiai-theme";
  const root = document.documentElement;
  const stored = localStorage.getItem(storageKey);
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = stored === "light" || stored === "dark" ? stored : systemDark ? "dark" : "light";
  root.dataset.theme = theme;
})();
`;

export default function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />;
}
