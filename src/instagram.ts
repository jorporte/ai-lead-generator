// src/instagram.ts
import 'dotenv/config'; 
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!url || !key) {
        throw new Error(`💥 Supabase Credentials Missing! Checked process.env.SUPABASE_URL (${url ? 'FOUND' : 'MISSING'}) and Supabase key (${key ? 'FOUND' : 'MISSING'}). Verify your .env file layout.`);
    }

    return createClient(url, key, { 
        auth: { persistSession: false }, 
        global: { fetch: (...args) => fetch(...args) }
    });
}

export async function publishDailyDeals(tireData: any) {
    if (!tireData || (!tireData.price && !tireData.salePrice)) {
        console.log('✨ No qualifying data payload passed to marketing trigger.');
        return;
    }

    const rawPrice = tireData.price || tireData.salePrice;
    const tireSize = tireData.size || tireData.scannedSize;
    
    const brand = tireData.brand && tireData.brand !== 'Unknown Brand' ? tireData.brand : 'Premium Brand';
    const model = tireData.model && tireData.model !== 'Unknown Model' ? tireData.model : 'Performance Series';
    const availableVolume = tireData.quantityAvailable || 4;
    const setsCount = Math.floor(availableVolume / 4);

    let markedUpPrice = rawPrice * 1.10;
    if (markedUpPrice < 75) {
        markedUpPrice = 75;
    }

    console.log(`🎨 Generating social flyer canvas asset for ${brand} — Market retail target: $${markedUpPrice.toFixed(2)} (+ Tax)`);

    try {
        const supabase = getSupabaseClient();

        let tireImageBuffer: Buffer;
        if (tireData.highResImageUrl) {
            const imageResponse = await axios.get(tireData.highResImageUrl, { responseType: 'arraybuffer' });
            tireImageBuffer = Buffer.from(imageResponse.data);
        } else {
            tireImageBuffer = await sharp({
                create: { width: 400, height: 400, channels: 3, background: { r: 30, g: 41, b: 59 } }
            }).png().toBuffer();
        }

        const processedTireImage = await sharp(tireImageBuffer)
            .resize(700, 700, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .toBuffer();

        // SVG updated to say "EACH (+ TAX)" instead of the hyped up text
        const svgOverlay = `
            <svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
                <rect x="0" y="780" width="1080" height="300" fill="#1e293b" opacity="0.95"/>
                <line x1="0" y1="780" x2="1080" y2="780" stroke="#3b82f6" stroke-width="8"/>
                
                <text x="60" y="850" font-family="Arial, Helvetica, sans-serif" font-size="46" font-weight="bold" fill="#ffffff">${brand.toUpperCase()}</text>
                <text x="60" y="910" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="#94a3b8">${model}</text>
                <text x="60" y="990" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="bold" fill="#3b82f6">SIZE: ${tireSize}</text>
                
                <text x="1020" y="860" font-family="Arial, Helvetica, sans-serif" font-size="75" font-weight="bold" fill="#22c55e" text-anchor="end">$${markedUpPrice.toFixed(2)}</text>
                <text x="1020" y="910" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="bold" fill="#94a3b8" text-anchor="end">EACH (+ TAX)</text>
                
                <rect x="760" y="950" width="260" height="50" rx="25" fill="#ef4444"/>
                <text x="890" y="985" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold" fill="#ffffff" text-anchor="middle">${setsCount} ${setsCount === 1 ? 'SET' : 'SETS'} AVAILABLE</text>
            </svg>
        `;

        const finalFlyerBuffer = await sharp({
            create: { width: 1080, height: 1080, channels: 4, background: { r: 15, g: 23, b: 42, alpha: 1 } }
        })
        .composite([
            { input: processedTireImage, top: 50, left: 190 },
            { input: Buffer.from(svgOverlay), top: 0, left: 0 }
        ])
        .jpeg({ quality: 95 })
        .toBuffer();

        const fileName = `deal_${Date.now()}.jpg`;
        const { data: storageData, error: storageError } = await supabase.storage
            .from('RebelMarketing') 
            .upload(fileName, finalFlyerBuffer, { contentType: 'image/jpeg', cacheControl: '3600' });

        if (storageError) throw storageError;

        const { data: urlData } = supabase.storage.from('RebelMarketing').getPublicUrl(fileName);
        const publicImageUrl = urlData.publicUrl;
        console.log(`✅ Media hosted on cloud storage: ${publicImageUrl}`);

        // Direct, transparent, "Robin Hood" style caption
        const caption = buildLeadCaption({
            brand,
            model,
            tireSize,
            markedUpPrice,
            setsCount,
            segment: tireData.segment,
        });

        const instagramAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
        const accessToken = process.env.META_ACCESS_TOKEN;

        if (instagramAccountId && accessToken) {
            console.log('🛰️ Initializing Instagram container upload stage...');
            const containerResponse = await axios.post(`https://graph.facebook.com/v19.0/${instagramAccountId}/media`, {
                image_url: publicImageUrl,
                caption: caption,
                access_token: accessToken
            });

            const creationContainerId = containerResponse.data.id;

            console.log('⏳ Waiting for Meta asset parsing context initialization...');
            await new Promise(resolve => setTimeout(resolve, 5000));

            console.log('🚀 Triggering live Instagram publish sequence...');
            await axios.post(`https://graph.facebook.com/v19.0/${instagramAccountId}/media_publish`, {
                creation_id: creationContainerId,
                access_token: accessToken
            });
        } else {
            console.log('📋 Instagram credentials missing. Skipping Instagram publish.');
        }

        await publishFacebookPhoto(publicImageUrl, caption);

        console.log('✅ Visual flyer cleanly exported and cross-posted to Meta streams.');

    } catch (error: any) {
        console.error('⚠️ Complete Marketing Pipeline Execution Failure:', error.response?.data || error.message || error);
    }
}

async function publishFacebookPhoto(publicImageUrl: string, caption: string) {
    const pageId = process.env.FACEBOOK_PAGE_ID;
    const pageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;

    if (!pageId || !pageAccessToken) {
        console.log('📋 Facebook Page credentials missing. Skipping Facebook publish.');
        return;
    }

    console.log('📣 Publishing deal flyer to Facebook Page...');
    await axios.post(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
        url: publicImageUrl,
        caption,
        published: true,
        access_token: pageAccessToken
    });
}

function buildLeadCaption(input: {
    brand: string;
    model: string;
    tireSize: string;
    markedUpPrice: number;
    setsCount: number;
    segment?: string;
}) {
    const segmentLine = input.segment ? `Built for: ${formatSegment(input.segment)}\n` : '';

    return `Wholesale tire deal just landed.\n\n${input.brand} ${input.model}\nSize: ${input.tireSize}\n${segmentLine}Price: $${input.markedUpPrice.toFixed(2)} / tire (+ tax)\nInventory: ${input.setsCount} ${input.setsCount === 1 ? 'set' : 'sets'} available locally.\n\nSend us a DM to lock in your set before it moves.\n\n#RebelWheels #TireDeals #LocalBusiness`;
}

function formatSegment(segment: string) {
    return segment
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export async function automateTokenExchange(shortLivedToken: string) {
    const appId = process.env.META_APP_ID;         
    const appSecret = process.env.META_APP_SECRET; 
    const envPath = path.join(__dirname, '../.env');

    if (!appId || !appSecret) {
        console.error('⚠️ Cannot automate exchange. META_APP_ID or META_APP_SECRET is missing from your env configuration.');
        return;
    }

    try {
        console.log('🛰️ Exchanging temporary token with Meta OAuth servers...');
        const response = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
            params: {
                grant_type: 'fb_exchange_token',
                client_id: appId,
                client_secret: appSecret,
                fb_exchange_token: shortLivedToken
            }
        });

        const longLivedToken = response.data.access_token;
        if (!longLivedToken) throw new Error('Meta server response did not include a valid access_token string.');

        console.log('📝 Exchanger received long-lived 60-day token. Overwriting local config...');

        let envContent = fs.readFileSync(envPath, 'utf8');
        const tokenRegex = /^META_ACCESS_TOKEN=.*/m;

        if (tokenRegex.test(envContent)) {
            envContent = envContent.replace(tokenRegex, `META_ACCESS_TOKEN=${longLivedToken}`);
        } else {
            envContent += `\nMETA_ACCESS_TOKEN=${longLivedToken}`;
        }

        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log('✅ Local .env permanently updated. Automated background posting is active for the next 60 days!');

    } catch (error: any) {
        console.error('💥 Token Exchange Automation Failure:', error.response?.data || error.message);
    }
}
