import { encryptWithAes256Gcm, decryptWithAes256Gcm } from '@kasitek/server-support/crypto';
import type { CoreConfig } from '../config.js';
import { ApiError } from '../error.js';
function secret(config: CoreConfig): string { const value = config.rawEnv.SOCIAL_TOKEN_ENCRYPTION_KEY ?? config.rawEnv.WHATSAPP_TOKEN_ENCRYPTION_KEY; if (value === undefined)
    throw new ApiError(500, 'internal_error', 'SOCIAL_TOKEN_ENCRYPTION_KEY or WHATSAPP_TOKEN_ENCRYPTION_KEY is required'); return value; }
export function encryptSocialSecret(config: CoreConfig, plaintext: string): string { const key = secret(config); try {
    return encryptWithAes256Gcm(key, plaintext);
}
catch (error) {
    throw new ApiError(500, 'internal_error', `Failed to encrypt token: ${error instanceof Error ? error.message : 'encryption failed'}`);
} }
export function decryptSocialSecret(config: CoreConfig, payload: string): string { const key = secret(config); try {
    return decryptWithAes256Gcm(key, payload);
}
catch (error) {
    throw new ApiError(500, 'internal_error', `Failed to decrypt token: ${error instanceof Error ? error.message : 'decryption failed'}`);
} }
