export type { ResolvedTheme as AppTheme, ThemeMode } from "./appearance";
export const THEME_STORAGE_KEY = "kasitek-theme";
export {
  applyTheme,
  resolveStoredTheme,
  serverThemeSnapshot,
  subscribeToThemeChange,
} from "./appearance";
