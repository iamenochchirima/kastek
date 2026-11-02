import { connectorConfiguration } from "./connector-registry";
import { GoogleCalendarClient } from "./google-calendar";
import { MicrosoftCalendarClient } from "./microsoft-calendar";
import type { CalendarClient,CalendarOptions } from "./calendar-contracts";
import { PlatformError } from "../../contracts/contracts";

export function calendarClient(providerId:string,token:string,options:CalendarOptions):CalendarClient {
  const definition=connectorConfiguration(providerId);
  switch(definition.adapterKey){
    case "google-calendar-v1":return new GoogleCalendarClient(token,{...options,apiBaseUrl:definition.apiBaseUrl});
    case "microsoft-calendar-v1":return new MicrosoftCalendarClient(token,{...options,apiBaseUrl:definition.apiBaseUrl});
    default:throw new PlatformError("CALENDAR_HANDLER_UNAVAILABLE",503,"Calendar provider is unavailable");
  }
}
