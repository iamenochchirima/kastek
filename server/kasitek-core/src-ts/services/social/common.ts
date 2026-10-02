import {ApiError} from '../../error.js';
import {UtcTimestamp} from '../../db.js';
export const PLATFORMS=['FACEBOOK','INSTAGRAM','THREADS','TIKTOK','BLUESKY','LINKEDIN','X'];
export const CHANNEL_STATUSES=['CONNECTED','DISCONNECTED','NEEDS_REAUTH'];
export const POST_STATUSES=['DRAFT','SCHEDULED','PROCESSING','PUBLISHED','FAILED'];
export const JOB_STATUSES=['PENDING','QUEUED','PROCESSING','PUBLISHED','FAILED','CANCELED'];
export const VARIANT_STATUSES=['DRAFT','APPROVED','NEEDS_EDITS'];
export const isValidPlatform=(value:string)=>PLATFORMS.includes(value);
export const bad=(message:string)=>new ApiError(400,'bad_request',message);
export const missing=(message:string)=>new ApiError(404,'not_found',message);
export const internal=(message:string)=>new ApiError(500,'internal_error',message);
export const trimmed=(value:string|null|undefined)=>value?.trim()||null;
export function parseOptionalDatetime(value:string|null|undefined):Date|null {const raw=trimmed(value);if(!raw)return null;try{if(!/^\d{4}-\d\d-\d\d[Tt]\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:[Zz]|[+-]\d\d:\d\d)$/.test(raw))throw new Error();const result=new UtcTimestamp(raw,true);const datePart=raw.slice(0,10);const [year,month,day]=datePart.split('-').map(Number);if(month!<1||month!>12||day!<1||day!>new Date(Date.UTC(year!,month!,0)).getUTCDate())throw new Error();return result;}catch{throw bad('Scheduled time is invalid');}}
