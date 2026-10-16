import {
  ACCENTS,
  setAccent,
  setDensity,
  setTheme,
  setInterfacePreference,
  useAppearance,
} from "@/lib/appearance";
import { Button } from "@/components/ui/button";
export function AppearanceSettings() {
  const prefs = useAppearance();
  return (
    <section className="rounded-lg border border-border bg-card p-6">
      <h2 className="text-base font-semibold">Appearance</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Make this workspace comfortable for you. Business branding is managed
        separately.
      </p>
      <fieldset className="mt-6">
        <legend className="mb-3 text-sm font-medium">Theme</legend>
        <div className="flex flex-wrap gap-2">
          {(["light", "dark", "system"] as const).map((theme) => (
            <Button
              key={theme}
              variant={prefs.theme === theme ? "default" : "outline"}
              aria-pressed={prefs.theme === theme}
              onClick={() => setTheme(theme)}
              className="capitalize"
            >
              {theme}
            </Button>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-6">
        <legend className="mb-3 text-sm font-medium">Accent colour</legend>
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((accent) => (
            <Button
              key={accent.id}
              variant="outline"
              aria-pressed={prefs.accent === accent.id}
              onClick={() => setAccent(accent.id)}
              className={prefs.accent === accent.id ? "ring-2 ring-ring" : ""}
            >
              <span
                className="size-3 rounded-full"
                style={{ backgroundColor: accent.swatch }}
              />
              {accent.name}
            </Button>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-6">
        <legend className="mb-3 text-sm font-medium">Density</legend>
        <div className="flex gap-2">
          {(["comfortable", "compact"] as const).map((density) => (
            <Button
              key={density}
              variant={prefs.density === density ? "default" : "outline"}
              aria-pressed={prefs.density === density}
              onClick={() => setDensity(density)}
              className="capitalize"
            >
              {density}
            </Button>
          ))}
        </div>
      </fieldset>
      <label className="mt-6 flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={prefs.interface.reduceMotion}
          onChange={(event) =>
            setInterfacePreference("reduceMotion", event.target.checked)
          }
        />
        Reduce motion
      </label>
    </section>
  );
}
