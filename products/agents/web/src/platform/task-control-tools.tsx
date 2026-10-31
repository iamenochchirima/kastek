import type { Configuration } from "./api";

const taskTools = [{ id: "tasks.inspect", label: "Task status" }, { id: "tasks.cancel", label: "Cancel tasks" }] as const;
export function TaskControlTools({ configuration, onChange }: { configuration: Configuration; onChange: (configuration: Configuration) => void }) {
  if (configuration.productBindings?.length || configuration.program?.version === "3") return null;
  const tools = configuration.tools ?? [];
  return <fieldset className="space-y-3 border-t border-border pt-4"><legend className="text-sm font-medium">Task tools</legend>
    {taskTools.map(tool => <label key={tool.id} className="flex min-h-10 items-center gap-3 text-sm"><input className="size-4 accent-primary" type="checkbox" checked={tools.includes(tool.id)} onChange={event => onChange({ ...configuration, ...(event.target.checked && configuration.program?.version !== "4" ? { program: { id: "tool-directed", version: "2" } as const } : {}), tools: event.target.checked ? [...tools, tool.id] : tools.filter(id => id !== tool.id) })} />{tool.label}</label>)}
  </fieldset>;
}
