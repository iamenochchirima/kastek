export class AnalyticsError extends Error {
 constructor(message:string, options?:ErrorOptions){super(message,options);this.name='AnalyticsError';}
}

/** Mirrors Actix's extractor boundary: request deserialization failures are plain-text 400s. */
export class RequestExtractionError extends Error {
 readonly statusCode=400;
 readonly kind:'json'|'query';
 constructor(message:string,kind:'json'|'query'='json'){super(message);this.name='RequestExtractionError';this.kind=kind;}
}

export function errorType(error:unknown):string {
 return error instanceof Error && error.name ? error.name : 'UnknownError';
}
