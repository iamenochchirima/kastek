export async function applyDraftUpdates<T extends {id:string}>(records:T[], update:(record:T)=>Promise<Response>) {
  let updated=0;const failures:Array<{leadId:string;status:number}>=[];
  for (const record of records) {
    try { const response=await update(record);if(response.ok) updated++;else failures.push({leadId:record.id,status:response.status}); }
    catch { failures.push({leadId:record.id,status:503}); }
  }
  return {updated,failures};
}
