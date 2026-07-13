import 'dotenv/config';
import axios from 'axios';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { URL } from 'url';

const GRAPH_VERSION = 'v19.0';
const DEFAULT_REDIRECT_URI = 'http://localhost:3456/callback';
const REQUIRED_SCOPES = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'instagram_basic',
    'instagram_content_publish',
];

type PageAccount = {
    id: string;
    name: string;
    access_token: string;
};

async function main() {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const redirectUri = process.env.META_REDIRECT_URI || DEFAULT_REDIRECT_URI;

    if (!appId || !appSecret) {
        throw new Error('META_APP_ID and META_APP_SECRET are required in .env before running npm run meta:auth.');
    }

    const authUrl = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    authUrl.searchParams.set('client_id', appId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', REQUIRED_SCOPES.join(','));
    authUrl.searchParams.set('response_type', 'code');

    console.log('\nOpen this URL in your browser and approve the requested Page/Instagram permissions:\n');
    console.log(authUrl.toString());
    console.log('\nWaiting for Meta OAuth callback...\n');

    const code = await waitForOAuthCode(redirectUri);
    const shortLivedToken = await exchangeCodeForToken(appId, appSecret, redirectUri, code);
    const longLivedToken = await exchangeForLongLivedToken(appId, appSecret, shortLivedToken);
    const pages = await fetchPages(longLivedToken);

    if (pages.length === 0) {
        throw new Error('No Facebook Pages were returned. Confirm your Facebook user has full control of the Rebel Wheels Page.');
    }

    const selectedPage = selectPage(pages);
    const instagramAccountId = await fetchInstagramBusinessAccountId(selectedPage.id, selectedPage.access_token);

    if (!instagramAccountId) {
        throw new Error(`Page "${selectedPage.name}" does not have a connected Instagram business/professional account.`);
    }

    updateEnvFile({
        META_ACCESS_TOKEN: longLivedToken,
        FACEBOOK_PAGE_ID: selectedPage.id,
        FACEBOOK_PAGE_ACCESS_TOKEN: selectedPage.access_token,
        INSTAGRAM_ACCOUNT_ID: instagramAccountId,
        META_REDIRECT_URI: redirectUri,
    });

    console.log('\nMeta publishing credentials updated in .env:');
    console.log(`- Facebook Page: ${selectedPage.name} (${selectedPage.id})`);
    console.log(`- Instagram Account ID: ${instagramAccountId}`);
    console.log('\nKeep DRY_RUN=true until you are ready for a controlled live publish test.\n');
}

function waitForOAuthCode(redirectUri: string) {
    const callbackUrl = new URL(redirectUri);
    const port = Number(callbackUrl.port || 80);
    const callbackPath = callbackUrl.pathname;

    return new Promise<string>((resolve, reject) => {
        const server = http.createServer((req, res) => {
            if (!req.url) return;

            const requestUrl = new URL(req.url, redirectUri);
            if (requestUrl.pathname !== callbackPath) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const error = requestUrl.searchParams.get('error_description') || requestUrl.searchParams.get('error');
            if (error) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end(`Meta authorization failed: ${error}`);
                server.close();
                reject(new Error(error));
                return;
            }

            const code = requestUrl.searchParams.get('code');
            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Missing authorization code.');
                server.close();
                reject(new Error('Meta callback did not include an authorization code.'));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Meta authorization complete</h1><p>You can return to the terminal.</p>');
            server.close();
            resolve(code);
        });

        server.on('error', reject);
        server.listen(port, callbackUrl.hostname);
    });
}

async function exchangeCodeForToken(appId: string, appSecret: string, redirectUri: string, code: string) {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
        params: {
            client_id: appId,
            client_secret: appSecret,
            redirect_uri: redirectUri,
            code,
        },
    });

    return response.data.access_token as string;
}

async function exchangeForLongLivedToken(appId: string, appSecret: string, shortLivedToken: string) {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`, {
        params: {
            grant_type: 'fb_exchange_token',
            client_id: appId,
            client_secret: appSecret,
            fb_exchange_token: shortLivedToken,
        },
    });

    return response.data.access_token as string;
}

async function fetchPages(accessToken: string) {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`, {
        params: {
            fields: 'id,name,access_token',
            access_token: accessToken,
        },
    });

    return response.data.data as PageAccount[];
}

function selectPage(pages: PageAccount[]) {
    const preferredPageName = process.env.FACEBOOK_PAGE_NAME?.toLowerCase();
    if (preferredPageName) {
        const preferredPage = pages.find(page => page.name.toLowerCase().includes(preferredPageName));
        if (preferredPage) return preferredPage;
    }

    if (pages.length === 1) return pages[0]!;

    console.log('Multiple Pages were returned. Set FACEBOOK_PAGE_NAME in .env to choose a specific one.');
    pages.forEach((page, index) => {
        console.log(`${index + 1}. ${page.name} (${page.id})`);
    });

    console.log('\nDefaulting to the first returned Page for now.\n');
    return pages[0]!;
}

async function fetchInstagramBusinessAccountId(pageId: string, pageAccessToken: string) {
    const response = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}`, {
        params: {
            fields: 'instagram_business_account',
            access_token: pageAccessToken,
        },
    });

    return response.data.instagram_business_account?.id as string | undefined;
}

function updateEnvFile(values: Record<string, string>) {
    const envPath = path.join(__dirname, '../.env');
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

    for (const [key, value] of Object.entries(values)) {
        const escapedValue = value.replace(/\$/g, '\\$');
        const lineRegex = new RegExp(`^${key}=.*$`, 'm');

        if (lineRegex.test(envContent)) {
            envContent = envContent.replace(lineRegex, `${key}=${escapedValue}`);
        } else {
            envContent += `${envContent.endsWith('\n') || envContent.length === 0 ? '' : '\n'}${key}=${escapedValue}\n`;
        }
    }

    fs.writeFileSync(envPath, envContent, 'utf8');
}

main().catch((error: any) => {
    console.error('\nMeta auth setup failed:', error.response?.data || error.message || error);
    process.exit(1);
});
