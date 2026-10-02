export class AnalyticsError extends Error {
 constructor(message:string, options?:ErrorOptions){super(message,options);this.name='AnalyticsError';}
}

/** Mirrors Actix's extractor boundary: request deserialization failures are plain-text 400s. */
export class RequestExtractionError extends Error {
 readonly statusCode=400;
 constructor(message:string){super(message);this.name='RequestExtractionError';}
}

export function errorType(error:unknown):string {
 return error instanceof Error && error.name ? error.name : 'UnknownError';
}
