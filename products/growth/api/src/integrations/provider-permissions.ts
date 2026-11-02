export type ProviderAdapter = 'MetaFacebook' | 'MetaInstagram' | 'InstagramDirect' | 'WhatsApp' | 'Threads' | 'TikTok' | 'LinkedInMember' | 'LinkedInOrganization' | 'X' | 'Bluesky' | 'GoogleEmail' | 'MicrosoftEmail' | 'Unknown';
export interface CapabilityRule {
    supported: boolean;
    requestable: boolean;
    requiresTargetCheck: boolean;
    providerPermission: string | null;
    grants: string[];
    requestScopes: string[];
}
export type Metadata = Record<string, unknown> | null;
export function adapterFor(provider: string, authMode?: string | null, metadata?: Metadata): ProviderAdapter {
    switch (provider.toUpperCase()) {
        case 'FACEBOOK': return 'MetaFacebook';
        case 'INSTAGRAM': return authMode === 'instagram_login' ? 'InstagramDirect' : 'MetaInstagram';
        case 'WHATSAPP': return 'WhatsApp';
        case 'THREADS': return 'Threads';
        case 'TIKTOK': return 'TikTok';
        case 'LINKEDIN': return metadata?.accountType === 'organization' ? 'LinkedInOrganization' : 'LinkedInMember';
        case 'X': return 'X';
        case 'BLUESKY': return 'Bluesky';
        case 'GOOGLE': return 'GoogleEmail';
        case 'MICROSOFT': return 'MicrosoftEmail';
        default: return 'Unknown';
    }
}
export function authMode(adapter: ProviderAdapter): string { return { MetaFacebook: 'meta_login', MetaInstagram: 'meta_login', InstagramDirect: 'instagram_login', WhatsApp: 'whatsapp_embedded_signup', Threads: 'threads_oauth', TikTok: 'tiktok_oauth', LinkedInMember: 'linkedin_oauth', LinkedInOrganization: 'linkedin_oauth', X: 'x_oauth', Bluesky: 'bluesky_oauth', GoogleEmail: 'google_email_oauth', MicrosoftEmail: 'microsoft_email_oauth', Unknown: 'unknown' }[adapter]; }
export function providerName(adapter: ProviderAdapter): string { return { MetaFacebook: 'FACEBOOK', MetaInstagram: 'INSTAGRAM', InstagramDirect: 'INSTAGRAM', WhatsApp: 'WHATSAPP', Threads: 'THREADS', TikTok: 'TIKTOK', LinkedInMember: 'LINKEDIN', LinkedInOrganization: 'LINKEDIN', X: 'X', Bluesky: 'BLUESKY', GoogleEmail: 'GOOGLE', MicrosoftEmail: 'MICROSOFT', Unknown: 'UNKNOWN' }[adapter]; }
const unsupported = (): CapabilityRule => ({ supported: false, requestable: false, requiresTargetCheck: false, providerPermission: null, grants: [], requestScopes: [] });
const unknownSupported = (): CapabilityRule => ({ supported: true, requestable: false, requiresTargetCheck: true, providerPermission: null, grants: [], requestScopes: [] });
const rule = (permission: string, requestable = true, target = false, grants = [permission], scopes = grants): CapabilityRule => ({ supported: true, requestable, requiresTargetCheck: target, providerPermission: permission || null, grants, requestScopes: scopes });
export function capability(adapter: ProviderAdapter, key: string): CapabilityRule {
    const publishing = ['SOCIAL_PUBLISH', 'MEDIA_PUBLISH'];
    switch (adapter) {
        case 'MetaFacebook':
            if (['MESSAGING_INBOUND', 'MESSAGING_OUTBOUND'].includes(key))
                return rule('pages_messaging', true, false, ['pages_messaging', 'MESSAGING'], ['pages_messaging']);
            if ([...publishing, 'SOCIAL_POST_DELETE'].includes(key))
                return rule('pages_manage_posts', true, false, ['pages_manage_posts', 'CREATE_CONTENT'], ['pages_manage_posts', 'pages_read_engagement']);
            if (key === 'SOCIAL_ANALYTICS')
                return rule('read_insights', true, false, ['read_insights', 'VIEW_INSIGHTS'], ['read_insights']);
            if (key === 'COMMENTS_MANAGE')
                return rule('pages_manage_engagement', true, false, ['pages_manage_engagement', 'MODERATE', 'COMMUNITY'], ['pages_manage_engagement']);
            break;
        case 'MetaInstagram':
            if (['MESSAGING_INBOUND', 'MESSAGING_OUTBOUND'].includes(key))
                return rule('instagram_manage_messages');
            if (publishing.includes(key))
                return rule('instagram_content_publish');
            if (key === 'SOCIAL_ANALYTICS')
                return rule('instagram_manage_insights');
            if (key === 'COMMENTS_MANAGE')
                return rule('instagram_manage_comments');
            if (key === 'SOCIAL_POST_DELETE')
                return rule('instagram_manage_contents');
            break;
        case 'InstagramDirect':
            if (['MESSAGING_INBOUND', 'MESSAGING_OUTBOUND'].includes(key))
                return rule('instagram_business_manage_messages');
            if (publishing.includes(key))
                return rule('instagram_business_content_publish');
            if (key === 'SOCIAL_ANALYTICS')
                return rule('instagram_business_manage_insights');
            if (key === 'COMMENTS_MANAGE')
                return rule('instagram_business_manage_comments');
            break;
        case 'WhatsApp':
            if (['MESSAGING_INBOUND', 'MESSAGING_OUTBOUND'].includes(key))
                return rule('whatsapp_business_messaging', true, true);
            if (key === 'MEDIA_PUBLISH')
                return rule('whatsapp_business_management', true, true, ['whatsapp_business_management', 'business_management']);
            if (key === 'SOCIAL_ANALYTICS')
                return unknownSupported();
            break;
        case 'Threads':
            if (publishing.includes(key))
                return rule('threads_content_publish');
            if (key === 'SOCIAL_ANALYTICS')
                return rule('threads_manage_insights');
            if (key === 'COMMENTS_MANAGE')
                return rule('threads_manage_replies');
            if (key === 'SOCIAL_POST_DELETE')
                return rule('threads_delete');
            break;
        case 'TikTok':
            if (key === 'SOCIAL_PUBLISH')
                return rule('video.publish');
            if (key === 'MEDIA_PUBLISH')
                return rule('video.upload');
            if (key === 'SOCIAL_ANALYTICS')
                return rule('user.info.stats');
            break;
        case 'LinkedInMember':
            if (publishing.includes(key))
                return rule('w_member_social');
            if (key === 'SOCIAL_ANALYTICS')
                return rule('r_member_postAnalytics');
            if (key === 'COMMENTS_MANAGE')
                return rule('r_member_social');
            if (key === 'SOCIAL_POST_DELETE')
                return unknownSupported();
            break;
        case 'LinkedInOrganization':
            if (publishing.includes(key))
                return rule('w_organization_social', true, true);
            if (key === 'SOCIAL_ANALYTICS')
                return rule('r_organization_admin', true, true);
            if (key === 'COMMENTS_MANAGE')
                return rule('r_organization_social', true, true);
            if (key === 'SOCIAL_POST_DELETE')
                return unknownSupported();
            break;
        case 'X':
            if (key === 'MESSAGING_INBOUND')
                return rule('dm.read');
            if (key === 'MESSAGING_OUTBOUND')
                return rule('dm.write');
            if (['SOCIAL_PUBLISH', 'SOCIAL_POST_DELETE', 'COMMENTS_MANAGE'].includes(key))
                return rule('tweet.write');
            if (key === 'MEDIA_PUBLISH')
                return rule('media.write');
            if (key === 'SOCIAL_ANALYTICS')
                return rule('tweet.read');
            break;
        case 'Bluesky':
            if (['SOCIAL_PUBLISH', 'SOCIAL_POST_DELETE'].includes(key))
                return rule('repo:app.bsky.feed.post');
            if (key === 'MEDIA_PUBLISH')
                return rule('blob:*/*');
            break;
        case 'GoogleEmail':
            if (['EMAIL_INBOUND', 'EMAIL_READ'].includes(key))
                return rule('https://www.googleapis.com/auth/gmail.readonly', false);
            if (['EMAIL_OUTBOUND', 'EMAIL_REPLY'].includes(key))
                return rule('https://www.googleapis.com/auth/gmail.send', false);
            break;
        case 'MicrosoftEmail':
            if (['EMAIL_INBOUND', 'EMAIL_READ'].includes(key))
                return rule('Mail.Read', false);
            if (['EMAIL_OUTBOUND', 'EMAIL_REPLY'].includes(key))
                return rule('Mail.Send', false);
            break;
    }
    return unsupported();
}
export function requiredScopes(adapter: ProviderAdapter, requested: string[], configured?: string | null): string[] {
    const scopes = [...new Set((configured ?? '').split(/[, ]/).map(v => v.trim()).filter(Boolean))];
    for (const key of requested)
        for (const scope of capability(adapter, key).requestScopes)
            if (!scopes.includes(scope))
                scopes.push(scope);
    for (const scope of adapter === 'MetaFacebook' ? ['pages_show_list', 'pages_manage_metadata', 'business_management'] : adapter === 'MetaInstagram' ? ['instagram_basic'] : [])
        if (!scopes.includes(scope))
            scopes.push(scope);
    return scopes;
}
