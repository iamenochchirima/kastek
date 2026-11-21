import type { IngestionJobDTO } from "../../platform/knowledge";
import type { WebsiteCrawlStore } from "../agents/website-crawls";
import type { ProviderConnection } from "../../contracts/model-providers";

type Crawl=Awaited<ReturnType<WebsiteCrawlStore["get"]>>;
function pageUrl(value:string) {const url=new URL(value);url.search="";url.hash="";return url.href;}
export function crawlSummary(crawl:Crawl) {return {id:crawl.id,url:pageUrl(crawl.url),state:crawl.state,total:crawl.total,completed:crawl.completed,errorCode:crawl.errorCode,importJobId:crawl.importJobId,createdAt:crawl.createdAt};}
export function crawlPage(crawl:Crawl,offset:number,limit:number) {const pages=crawl.pages.slice(offset,offset+limit).map(page=>({id:page.id,url:pageUrl(page.url),title:page.title}));const nextOffset=offset+pages.length<crawl.pages.length?offset+pages.length:null;return {...crawlSummary(crawl),pages,nextOffset};}
export function knowledgeJob(job:IngestionJobDTO) {return {id:job.id,sourceId:job.sourceId,revisionId:job.revisionId,revision:job.revision,state:job.state,errorCode:job.errorCode,createdAt:job.createdAt};}
export function modelConnection(connection:ProviderConnection) {return {id:connection.id,name:connection.name,providerId:connection.providerId,state:connection.state,verification:connection.verification};}
