export async function allOutreachPages<T>(path: string, request: (path:string)=>Promise<Response>):Promise<T[]> {
  const result:T[]=[];
  for(let page=1;;page++) {
    const response=await request(`${path}${path.includes('?')?'&':'?'}paginate=true&limit=200&page=${page}`);
    if(!response.ok) throw new Error('Could not load outreach records');
    const data=await response.json() as {items:T[];total:number};
    if(!Array.isArray(data.items) || !Number.isFinite(data.total)) throw new Error('Invalid outreach page');
    result.push(...data.items);
    if(result.length>=data.total) return result;
    if(!data.items.length) throw new Error('Outreach results changed; reload and try again');
  }
}
