import { PlatformError } from "../../contracts/contracts";
/** Provider chat/thread identity is distinct from the user who authored a group message. */
export function channelRecipient(kind:string,assetId:string,externalConversationId:string):string {
  if(!["facebook","instagram"].includes(kind))return externalConversationId;
  if(!externalConversationId.startsWith(`${assetId}:`)||externalConversationId.length<=assetId.length+1)
    throw new PlatformError("CHANNEL_DESTINATION_INVALID",409,"The channel conversation destination is unavailable");
  return externalConversationId.slice(assetId.length+1);
}
