import { api, ApiError, organizationPath } from "./api";
export type ChannelKind = "website" | "whatsapp" | "telegram" | "facebook" | "instagram";
export const channelNames: Record<ChannelKind,string> = {website:"Website",whatsapp:"WhatsApp",telegram:"Telegram",facebook:"Messenger",instagram:"Instagram"};
export type CustomerChannel = {kind:ChannelKind;name:string;setup:string;assetLabel:string;modes:{id:string;available:boolean;reason:string|null}[];capabilities:{inboundText:boolean;outboundText:boolean;inboundAttachments:string[];outboundAttachments:string[];receipts:string[]};restrictions:string[]};
export type ChannelConnection = {id:string;kind:ChannelKind;name:string;assetId:string|null;mode:string;state:"pending"|"active"|"needs_attention"|"disconnected"|"removed";revision:number;credentialRevision:number;metadata:Record<string,unknown>};
export type ChannelDeployment = {id:string;connectionId:string;agentId:string;versionId:string;state:"active"|"paused"|"revoked";revision:number};
export type ChannelList = {connections:ChannelConnection[];deployments:ChannelDeployment[];websites:{id:string;agentId:string;agentName:string;allowedOrigins:string[]}[];setupClaims?:{connectionId:string;state:string;expiresAt:string}[];ingressFailures?:{connectionId:string;count:number;reason:string|null}[]};
export type ChannelAsset = {id:string;name:string;eligible:boolean;reasonCode:string|null;metadata:Record<string,unknown>};
export type MetaBegin = {flow:"oauth";state:string;authorizationUrl:string}|{flow:"embedded_signup";state:string;appId:string;apiVersion:string;configurationId:string;messageOrigins:string[];responseType:"code";overrideDefaultResponseType:boolean;extras:Record<string,unknown>};
export type TelegramSetup = {connection:ChannelConnection;status:string;replacementConfirmation?:string};
export const channelPath = (organizationId:string) => `${organizationPath(organizationId)}/channels`;
export const channelApi = <T>(organizationId:string,suffix="",body?:unknown,method?:string) => api<T>(`${channelPath(organizationId)}${suffix}`,body,method);
export function channelError(error:unknown):string {
  const recovery:Record<string,string>={
    CHANNEL_SETUP_NOT_CONFIGURED:"Channel setup is unavailable. Contact your workspace operator.",
    CHANNEL_SETUP_EXPIRED_OR_CHANGED:"Setup expired or changed. Connect the account again.",
    CHANNEL_SETUP_CONFIGURATION_CHANGED:"Setup changed. Connect the account again.",
    CHANNEL_ASSET_CONFLICT:"This asset is already connected. Disconnect its current connection first.",
    CHANNEL_PERMISSION_DENIED:"Messaging permissions are missing. Reconnect and grant the required access.",
    CHANNEL_AUTHENTICATION_FAILED:"Account access expired or was rejected. Reconnect the account.",
    CHANNEL_CONNECTION_CHANGED:"Connection changed. Close and reopen setup.",
    CHANNEL_SETUP_PROVIDER_OUTCOME_UNKNOWN:"The provider response is uncertain. Check the account before reconnecting.",
    TELEGRAM_SETUP_RECONCILIATION_REQUIRED:"Webhook setup is uncertain. Check health before retrying setup.",
    TELEGRAM_SETUP_IN_PROGRESS:"Webhook setup is still in progress. Check health shortly.",
    TELEGRAM_TOKEN_INVALID:"Bot token rejected. Check the token with BotFather.",
    TELEGRAM_BOT_MISMATCH:"This token belongs to a different bot. Add it as a new connection.",
    TELEGRAM_WEBHOOK_UNKNOWN:"Webhook status is uncertain. Check connection health before retrying.",
    CHANNEL_RATE_LIMITED:"Provider rate limit reached. Try again later.",
  };
  if(error instanceof ApiError){if(error.code&&recovery[error.code])return recovery[error.code];if(error.status===403)return "Workspace owner access required.";if(error.status===409)return "Connection changed. Refresh and try again.";}
  return error instanceof Error?error.message:"Channel setup failed. Try again.";
}
