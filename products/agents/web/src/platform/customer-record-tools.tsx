import { type Configuration } from "./api";

type Tool = NonNullable<Configuration["tools"]>[number];
const staffTools: Array<{id:Tool;label:string}> = [
 {id:"records.search",label:"Search customer records"},
 {id:"records.update",label:"Update enquiry follow-up"},
];
export function CustomerRecordTools({configuration,onChange}:{configuration:Configuration;onChange:(configuration:Configuration)=>void}) {
 const tools = configuration.tools ?? [];
 function toggle(id:Tool,enabled:boolean) {
  const selected=new Set(tools);
  if(enabled)selected.add(id);else selected.delete(id);
  onChange({...configuration,tools:[...selected]});
 }
 return <fieldset className="space-y-3 border-t border-border pt-4"><legend className="text-sm font-medium">Staff record tools</legend>
  <p className="text-xs text-muted-foreground">Available in authorized staff chats. Hidden from customers.</p>
  {staffTools.map(tool=><label key={tool.id} className="flex min-h-10 items-center gap-3 text-sm"><input className="size-4 accent-primary" type="checkbox" checked={tools.includes(tool.id)} onChange={event=>toggle(tool.id,event.target.checked)}/>{tool.label}</label>)}
 </fieldset>;
}
