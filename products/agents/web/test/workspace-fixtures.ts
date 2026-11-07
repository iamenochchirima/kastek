import { expect, type Page } from "@playwright/test";
export function agentSummary(agent:{id:string;name:string;draftRevision?:number},version?:{id:string;number:number}) {
 return {...agent,draftRevision:agent.draftRevision??1,updatedAt:"2026-10-18T12:00:00Z",latestVersion:version?{...version,draftRevision:agent.draftRevision??1,executionKind:"business"}:null,hasUnpublishedChanges:!version};
}
export function conversationSummaries(tasks:{conversationId:string;input:string;state:string;versionId?:string}[],agent:{id:string;name:string},version:{id:string;number:number}) {
 return [...new Map(tasks.map(task=>[task.conversationId,{id:task.conversationId,agentId:agent.id,agentName:agent.name,versionId:task.versionId??version.id,versionNumber:version.number,title:tasks.find(item=>item.conversationId===task.conversationId)!.input,updatedAt:"2026-10-18T12:00:00Z",state:task.state,canContinue:true}])).values()];
}
export async function configure(page:Page,section="General") {
 if((page.viewportSize()?.width??1440)<=640)await page.getByRole("button",{name:"Agent menu",exact:true}).click();
 if(section==="Website"){
  await page.getByRole("link",{name:"Chat widget",exact:true}).filter({visible:true}).last().click();
  return;
 }
 await page.getByRole("link",{name:"Behaviour",exact:true}).filter({visible:true}).last().click();
 if(section!=="General")await page.getByRole("button",{name:section,exact:true}).click();
}
export async function chooseConversation(page:Page,title:string) {
 if((page.viewportSize()?.width??1440)<=640)await page.getByRole("button",{name:"Agent menu",exact:true}).click();
 await page.getByRole("link",{name:"Conversations",exact:true}).filter({visible:true}).last().click();
 const link=page.getByRole("link",{name:new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"))});
 await expect(link.last()).toBeVisible();await link.last().click();
}
export async function newChat(page:Page) { await page.getByRole("button",{name:"New chat",exact:true}).filter({visible:true}).last().click(); }
export async function navigateWorkspace(page:Page,name:string) {
 if((page.viewportSize()?.width??1440)<=900)await page.getByRole("button",{name:"Open navigation",exact:true}).click();
 await page.getByRole("navigation",{name:"Main navigation",exact:true}).getByRole("link",{name,exact:true}).filter({visible:true}).click();
}
