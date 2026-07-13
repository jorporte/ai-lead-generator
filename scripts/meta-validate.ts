import 'dotenv/config';
import axios from 'axios';

const GRAPH_VERSION = 'v19.0';

async function main() {
    const metaAccessToken = requiredEnv('META_ACCESS_TOKEN');
    const facebookPageId = requiredEnv('FACEBOOK_PAGE_ID');
    const instagramAccountId = requiredEnv('INSTAGRAM_ACCOUNT_ID');
    const facebookPageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || metaAccessToken;

    console.log('\nValidating Meta publishing configuration...\n');

    await validateToken(metaAccessToken);
    await validatePage(facebookPageId, facebookPageAccessToken);
    await validateInstagramAccount(instagramAccountId, metaAccessToken);
    await validatePageInstagramConnection(facebookPageId, facebookPageAccessToken, instagramAccountId);

    console.log('\nMeta validation passed. Keep DRY_RUN=true for the next scraper run.\n');
}

function requiredEnv(name: string) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required in .env.`);
    }
    return value;
}

async function validateToken(accessToken: string) {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/me`, {
        params: {
            fields: 'id,name',
            access_token: accessToken,
        },
    });

    console.log(`Token owner: ${response.data.name || 'Unknown'} (${response.data.id})`);

    try {
        const permissionsResponse = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/me/permissions`, {
            params: { access_token: accessToken },
        });

        console.log('Granted permissions:');
        for (const permission of permissionsResponse.data.data || []) {
            console.log(`- ${permission.permission}: ${permission.status}`);
        }
    } catch {
        console.log('Permission list unavailable for this token type. Continuing with direct asset checks.');
    }
}

async function validatePage(pageId: string, pageAccessToken: string) {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}`, {
        params: {
            fields: 'id,name,access_token',
            access_token: pageAccessToken,
        },
    });

    console.log(`Facebook Page: ${response.data.name || 'Unknown'} (${response.data.id})`);
}

async function validateInstagramAccount(instagramAccountId: string, accessToken: string) {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${instagramAccountId}`, {
        params: {
            fields: 'id,username,name',
            access_token: accessToken,
        },
    });

    console.log(`Instagram account: @${response.data.username || 'unknown'} (${response.data.id})`);
}

async function validatePageInstagramConnection(pageId: string, pageAccessToken: string, expectedInstagramAccountId: string) {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}`, {
        params: {
            fields: 'instagram_business_account',
            access_token: pageAccessToken,
        },
    });

    const connectedInstagramId = response.data.instagram_business_account?.id;
    if (!connectedInstagramId) {
        throw new Error('The configured Facebook Page does not expose a connected Instagram business account.');
    }

    if (connectedInstagramId !== expectedInstagramAccountId) {
        throw new Error(`INSTAGRAM_ACCOUNT_ID=${expectedInstagramAccountId} does not match the Page-connected Instagram account ${connectedInstagramId}.`);
    }

    console.log('Facebook Page is connected to the configured Instagram account.');
}

main().catch((error: any) => {
    console.error('\nMeta validation failed:', error.response?.data || error.message || error);
    process.exit(1);
});
