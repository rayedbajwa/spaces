/**
 * The Slack bot scopes Spaces uses: one list for the OAuth request, the app
 * manifest and the missing-scope hint, so they cannot drift apart. im:write
 * opens the DMs that deliver approval requests.
 */
export const SLACK_BOT_SCOPES = ['channels:manage', 'channels:read', 'channels:join', 'chat:write', 'users:read', 'users:read.email', 'im:write']
