// src/instagram.ts
import 'dotenv/config'; 
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { isDryRun } from './config';
import type { TireDeal } from './analyzer';

type PreparedDeal = {
    deal: TireDeal;
    brand: string;
    model: string;
    tireSize: string;
    markedUpPrice: number;
    setsCount: number;
    flyerBuffer: Buffer;
};

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

export async function publishDailyDeals(tireData: TireDeal | TireDeal[]) {
    const deals = Array.isArray(tireData) ? tireData : [tireData];

    if (deals.length === 0) {
        console.log('✨ No qualifying data payload passed to marketing trigger.');
        return;
    }

    try {
        const preparedDeals = await Promise.all(deals.map(prepareDealFlyer));
        const caption = buildCarouselCaption(preparedDeals);

        if (isDryRun()) {
            console.log(`🧪 DRY_RUN enabled. Generated ${preparedDeals.length} flyer(s) in memory; Supabase, Instagram, and Facebook publishing skipped.`);
            preparedDeals.forEach((preparedDeal, index) => {
                console.log(`🧪 Flyer ${index + 1} bytes: ${preparedDeal.flyerBuffer.length}`);
            });
            console.log(`🧪 Caption preview:\n${caption}`);
            return;
        }

        const supabase = getSupabaseClient();
        const publicImageUrls = await uploadFlyersToSupabase(supabase, preparedDeals);

        const instagramAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
        const accessToken = process.env.META_ACCESS_TOKEN;

        if (instagramAccountId && accessToken) {
            await publishInstagramMedia(instagramAccountId, accessToken, publicImageUrls, caption);
        } else {
            console.log('📋 Instagram credentials missing. Skipping Instagram publish.');
        }

        await publishFacebookPhotos(publicImageUrls, caption);

        console.log('✅ Visual flyer cleanly exported and cross-posted to Meta streams.');

    } catch (error: any) {
        console.error('⚠️ Complete Marketing Pipeline Execution Failure:', error.response?.data || error.message || error);
    }
}

async function prepareDealFlyer(deal: TireDeal): Promise<PreparedDeal> {
    const rawPrice = deal.salePrice;
    const tireSize = deal.scannedSize;

    const brand = deal.brand && deal.brand !== 'Unknown Brand' ? deal.brand : 'Premium Brand';
    const model = deal.model && deal.model !== 'Unknown Model' ? deal.model : 'Performance Series';
    const availableVolume = deal.quantityAvailable || 4;
    const setsCount = Math.floor(availableVolume / 4);
    const markedUpPrice = Math.max(deal.salePrice * 1.10, 75);

    if (!rawPrice) {
        throw new Error(`Cannot generate flyer for ${brand} ${model}; missing sale price.`);
    }

    console.log(`🎨 Generating social flyer canvas asset for ${brand} — Market retail target: $${markedUpPrice.toFixed(2)} (+ Tax)`);

    let tireImageBuffer: Buffer;
    if (deal.highResImageUrl) {
        const imageResponse = await axios.get(deal.highResImageUrl, { responseType: 'arraybuffer' });
        tireImageBuffer = Buffer.from(imageResponse.data);
    } else {
        tireImageBuffer = await sharp({
            create: { width: 400, height: 400, channels: 3, background: { r: 30, g: 41, b: 59 } }
        }).png().toBuffer();
    }

    const processedTireImage = await sharp(tireImageBuffer)
        .resize(700, 700, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();

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

    const flyerBuffer = await sharp({
        create: { width: 1080, height: 1080, channels: 4, background: { r: 15, g: 23, b: 42, alpha: 1 } }
    })
    .composite([
        { input: processedTireImage, top: 50, left: 190 },
        { input: Buffer.from(svgOverlay), top: 0, left: 0 }
    ])
    .jpeg({ quality: 95 })
    .toBuffer();

    return {
        deal,
        brand,
        model,
        tireSize,
        markedUpPrice,
        setsCount,
        flyerBuffer,
    };
}

async function uploadFlyersToSupabase(supabase: ReturnType<typeof getSupabaseClient>, preparedDeals: PreparedDeal[]) {
    const urls: string[] = [];

    for (const [index, preparedDeal] of preparedDeals.entries()) {
        const safeSegment = preparedDeal.deal.segment || 'deal';
        const fileName = `deal_${Date.now()}_${index + 1}_${safeSegment}.jpg`;
        const { error: storageError } = await supabase.storage
            .from('RebelMarketing')
            .upload(fileName, preparedDeal.flyerBuffer, { contentType: 'image/jpeg', cacheControl: '3600' });

        if (storageError) throw storageError;

        const { data: urlData } = supabase.storage.from('RebelMarketing').getPublicUrl(fileName);
        urls.push(urlData.publicUrl);
        console.log(`✅ Media hosted on cloud storage: ${urlData.publicUrl}`);
    }

    return urls;
}

async function publishInstagramMedia(instagramAccountId: string, accessToken: string, publicImageUrls: string[], caption: string) {
    if (publicImageUrls.length === 1) {
        console.log('🛰️ Initializing Instagram image upload stage...');
        const containerResponse = await axios.post(`https://graph.facebook.com/v19.0/${instagramAccountId}/media`, {
            image_url: publicImageUrls[0],
            caption,
            access_token: accessToken
        });

        await publishInstagramContainer(instagramAccountId, accessToken, containerResponse.data.id);
        return;
    }

    console.log(`🛰️ Initializing Instagram carousel upload stage with ${publicImageUrls.length} images...`);
    const childContainerIds: string[] = [];

    for (const imageUrl of publicImageUrls) {
        const childResponse = await axios.post(`https://graph.facebook.com/v19.0/${instagramAccountId}/media`, {
            image_url: imageUrl,
            is_carousel_item: true,
            access_token: accessToken
        });
        childContainerIds.push(childResponse.data.id);
    }

    const carouselResponse = await axios.post(`https://graph.facebook.com/v19.0/${instagramAccountId}/media`, {
        media_type: 'CAROUSEL',
        children: childContainerIds.join(','),
        caption,
        access_token: accessToken
    });

    await publishInstagramContainer(instagramAccountId, accessToken, carouselResponse.data.id);
}

async function publishInstagramContainer(instagramAccountId: string, accessToken: string, creationContainerId: string) {
    console.log('⏳ Waiting for Meta asset parsing context initialization...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('🚀 Triggering live Instagram publish sequence...');
    await axios.post(`https://graph.facebook.com/v19.0/${instagramAccountId}/media_publish`, {
        creation_id: creationContainerId,
        access_token: accessToken
    });
}

async function publishFacebookPhotos(publicImageUrls: string[], caption: string) {
    const pageId = process.env.FACEBOOK_PAGE_ID;
    const pageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;

    if (!pageId || !pageAccessToken) {
        console.log('📋 Facebook Page credentials missing. Skipping Facebook publish.');
        return;
    }

    if (publicImageUrls.length === 1) {
        console.log('📣 Publishing deal flyer to Facebook Page...');
        await axios.post(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
            url: publicImageUrls[0],
            caption,
            published: true,
            access_token: pageAccessToken
        });
        return;
    }

    console.log(`📣 Publishing ${publicImageUrls.length} deal flyers to Facebook Page...`);
    const attachedMedia = [];

    for (const imageUrl of publicImageUrls) {
        const photoResponse = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
            url: imageUrl,
            published: false,
            access_token: pageAccessToken
        });
        attachedMedia.push({ media_fbid: photoResponse.data.id });
    }

    await axios.post(`https://graph.facebook.com/v19.0/${pageId}/feed`, {
        attached_media: attachedMedia,
        message: caption,
        access_token: pageAccessToken
    });
}

function buildCarouselCaption(preparedDeals: PreparedDeal[]) {
    const intro = preparedDeals.length === 1
        ? 'Wholesale tire deal just landed.'
        : `Wholesale tire drop just landed: ${preparedDeals.length} deals across different driving needs.`;

    const dealLines = preparedDeals.map((preparedDeal, index) => {
        const segmentLine = preparedDeal.deal.segment ? ` (${formatSegment(preparedDeal.deal.segment)})` : '';
        return `${index + 1}. ${preparedDeal.brand} ${preparedDeal.model}${segmentLine}\nSize: ${preparedDeal.tireSize}\nPrice: $${preparedDeal.markedUpPrice.toFixed(2)} / tire (+ tax)\nInventory: ${preparedDeal.setsCount} ${preparedDeal.setsCount === 1 ? 'set' : 'sets'} available locally.`;
    });

    const hashtags = selectHashtags(
        preparedDeals.map(preparedDeal => `${preparedDeal.brand} ${preparedDeal.model} ${preparedDeal.tireSize}`).join(' '),
        preparedDeals.map(preparedDeal => preparedDeal.deal.segment).filter(Boolean).join(' ')
    );

    return `${intro}\n\n${dealLines.join('\n\n')}\n\nSend us a DM to lock in a set before it moves.\n\n${hashtags.join(' ')}`;
}

function formatSegment(segment: string) {
    return segment
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

function selectHashtags(tireText: string, segment?: string) {
    const normalized = tireText.toLowerCase();
    const tags = new Set([
        '#NLAutomotive',
        '#NLCarCommunity',
        '#StJohnsCars',
        '#TireShopNL',
        '#NewTires',
    ]);

    if (segment?.includes('truck-lt') || segment?.includes('off-road')) {
        tags.add('#NLTrucks');
        tags.add('#NewfoundlandTrucks');
    }

    if (isWinterTireText(normalized)) {
        tags.add('#NLWinter');
        tags.add('#NewfoundlandWinter');
        tags.add('#NLWeather');
        tags.add('#WinterTiresNL');
        tags.add('#WinterTires');
    }

    if (normalized.includes('studded') || normalized.includes('stud')) {
        tags.add('#StuddedTires');
    }

    if (isAllSeasonTireText(normalized)) {
        tags.add('#AllSeasonTires');
    }

    tags.add('#TireChange');

    return Array.from(tags).slice(0, 12);
}

function isWinterTireText(normalized: string) {
    return [
        'winter',
        'snow',
        'ice',
        'arctic',
        'blizzak',
        'x-ice',
        'x ice',
        'iceguard',
        'hakkapeliitta',
        'observe',
        'wintercommand',
        'winterforce',
    ].some(keyword => normalized.includes(keyword));
}

function isAllSeasonTireText(normalized: string) {
    return [
        'all season',
        'all-season',
        'allseason',
        'weatherready',
        'crossclimate',
        'assurance',
        'defender',
    ].some(keyword => normalized.includes(keyword));
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
