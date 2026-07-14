// src/instagram.ts
import 'dotenv/config'; 
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { isDryRun } from './config';
import type { TireDeal } from './analyzer';

const ws = require('ws');
const DEFAULT_BRAND_LOGO_PATH = path.join(__dirname, '../assets/rebel-logo.png');

type PreparedDeal = {
    deal: TireDeal;
    brand: string;
    model: string;
    tireSize: string;
    markedUpPrice: number;
    regularPrice: number;
    discountPercent: number;
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
        global: { fetch: (...args) => fetch(...args) },
        realtime: { transport: ws }
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
            const previewUrls = writeDryRunPreviews(preparedDeals);
            console.log(`🧪 DRY_RUN enabled. Generated ${preparedDeals.length} flyer(s) in memory; Supabase, Instagram, and Facebook publishing skipped.`);
            preparedDeals.forEach((preparedDeal, index) => {
                console.log(`🧪 Flyer ${index + 1} bytes: ${preparedDeal.flyerBuffer.length}`);
                console.log(`🧪 Flyer ${index + 1} preview URL: ${previewUrls[index]}`);
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
    const regularPrice = deal.baselinePrice > deal.salePrice
        ? Math.max(deal.baselinePrice * 1.10, markedUpPrice)
        : 0;
    const discountPercent = Math.max(Math.round(deal.discountPercent), 0);
    const flyerBrand = escapeSvgText(truncateText(brand.toUpperCase(), 18));
    const flyerModelLines = formatFlyerModelLines(model);
    const flyerTireSize = escapeSvgText(tireSize);
    const tireSizeY = flyerModelLines.length > 1 ? 542 : 512;
    const tireSizeAccentY = tireSizeY + 32;
    const flyerSpecLines = selectFlyerSpecs(deal);
    const specStartY = tireSizeAccentY + 48;

    if (!rawPrice) {
        throw new Error(`Cannot generate flyer for ${brand} ${model}; missing sale price.`);
    }

    console.log(`🎨 Generating Rebel Wheels flyer for ${brand} — Sale $${markedUpPrice.toFixed(2)} vs regular $${regularPrice.toFixed(2)} (+ Tax)`);

    let tireImageBuffer: Buffer;
    if (deal.highResImageUrl) {
        const imageResponse = await axios.get(deal.highResImageUrl, { responseType: 'arraybuffer' });
        tireImageBuffer = Buffer.from(imageResponse.data);
    } else {
        tireImageBuffer = await sharp({
            create: { width: 400, height: 400, channels: 3, background: { r: 12, g: 12, b: 12 } }
        }).png().toBuffer();
    }

    const processedTireImage = await sharp(tireImageBuffer)
        .resize(705, 705, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
    const brandLogo = await getBrandLogoBuffer();

    const accentColor = '#ff7a1a';
    const boneText = '#f4f1e8';
    const mutedText = '#aaa7a0';
    const headlineFont = 'Impact, Haettenschweiler, Arial Black, Arial, Helvetica, sans-serif';
    const bodyFont = 'Arial, Helvetica, sans-serif';

    const backgroundLayer = `
        <svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="1080" height="1080" fill="#050505"/>
            <polygon points="610,0 1080,0 1080,770 785,770" fill="#101010"/>
            <polygon points="0,770 1080,770 1080,1080 0,1080" fill="#121212"/>
            <ellipse cx="748" cy="742" rx="246" ry="32" fill="#000000" opacity="0.55"/>
            <line x1="0" y1="770" x2="1080" y2="770" stroke="${boneText}" stroke-width="4"/>
            <line x1="58" y1="58" x2="344" y2="58" stroke="${boneText}" stroke-width="4"/>
            <line x1="58" y1="58" x2="58" y2="346" stroke="${boneText}" stroke-width="4"/>
        </svg>
    `;

    const foregroundLayer = `
        <svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
            ${discountPercent > 0 ? `
            <text x="74" y="98" font-family="${bodyFont}" font-size="24" font-weight="bold" fill="${accentColor}">CLEARANCE FIND</text>
            <text x="72" y="204" font-family="${headlineFont}" font-size="132" font-weight="900" fill="${boneText}">${discountPercent}%</text>
            <text x="76" y="260" font-family="${headlineFont}" font-size="48" font-weight="900" fill="${accentColor}">OFF</text>
            ` : ''}

            <text x="74" y="382" font-family="${headlineFont}" font-size="44" font-weight="900" fill="#ffffff">${flyerBrand}</text>
            ${flyerModelLines.map((line, index) => `<text x="74" y="${436 + index * 38}" font-family="${bodyFont}" font-size="31" fill="${mutedText}">${escapeSvgText(line)}</text>`).join('')}
            <text x="74" y="${tireSizeY}" font-family="${headlineFont}" font-size="39" font-weight="900" fill="#ffffff">${flyerTireSize}</text>
            <polygon points="74,${tireSizeAccentY} 236,${tireSizeAccentY} 214,${tireSizeAccentY + 16} 74,${tireSizeAccentY + 16}" fill="${accentColor}" opacity="0.9"/>
            ${flyerSpecLines.map((line, index) => `<text x="74" y="${specStartY + index * 32}" font-family="${bodyFont}" font-size="24" font-weight="bold" fill="${index === 0 ? accentColor : mutedText}">${escapeSvgText(line)}</text>`).join('')}

            ${regularPrice > 0 ? `
            <text x="74" y="866" font-family="${bodyFont}" font-size="30" font-weight="bold" fill="${mutedText}">WAS $${regularPrice.toFixed(2)}</text>
            <line x1="74" y1="856" x2="265" y2="856" stroke="${accentColor}" stroke-width="5"/>
            ` : ''}
            <text x="74" y="960" font-family="${headlineFont}" font-size="90" font-weight="900" fill="#ffffff">$${markedUpPrice.toFixed(2)}</text>
            <text x="78" y="1012" font-family="${bodyFont}" font-size="26" font-weight="bold" fill="${mutedText}">EACH + TAX</text>

            <rect x="742" y="866" width="266" height="66" fill="none" stroke="${accentColor}" stroke-width="3"/>
            <text x="875" y="907" font-family="${bodyFont}" font-size="23" font-weight="bold" fill="${accentColor}" text-anchor="middle">${setsCount} ${setsCount === 1 ? 'SET' : 'SETS'} LOCAL</text>
            <text x="875" y="972" font-family="${bodyFont}" font-size="20" font-weight="bold" fill="${mutedText}" text-anchor="middle">DM TO CLAIM</text>
        </svg>
    `;

    const flyerBuffer = await sharp({
        create: { width: 1080, height: 1080, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 1 } }
    })
    .composite([
        { input: Buffer.from(backgroundLayer), top: 0, left: 0 },
        { input: processedTireImage, top: 112, left: 385 },
        ...(brandLogo ? [{ input: brandLogo, top: 74, left: 836 }] : []),
        { input: Buffer.from(foregroundLayer), top: 0, left: 0 }
    ])
    .jpeg({ quality: 95 })
    .toBuffer();

    return {
        deal,
        brand,
        model,
        tireSize,
        markedUpPrice,
        regularPrice,
        discountPercent,
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

function writeDryRunPreviews(preparedDeals: PreparedDeal[]) {
    const outputDir = path.join(__dirname, '../data/dry-run');
    fs.mkdirSync(outputDir, { recursive: true });

    return preparedDeals.map((preparedDeal, index) => {
        const safeSegment = sanitizeFilePart(preparedDeal.deal.segment || 'deal');
        const safeSize = sanitizeFilePart(preparedDeal.tireSize);
        const fileName = `dry_run_${Date.now()}_${index + 1}_${safeSegment}_${safeSize}.jpg`;
        const filePath = path.join(outputDir, fileName);

        fs.writeFileSync(filePath, preparedDeal.flyerBuffer);
        return `file://${filePath}`;
    });
}

function sanitizeFilePart(value: string) {
    return value.replace(/[^a-z0-9-]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function selectFlyerSpecs(deal: TireDeal) {
    const specs = deal.customerSpecs || [];
    const preferredLabels = [
        'Load/speed rating',
        'Tire type',
        'Sidewall',
        'Winter traction',
        'Tread pattern',
        'Load strength',
    ];

    const selected: string[] = [];
    for (const label of preferredLabels) {
        const spec = specs.find(candidate => candidate.label === label);
        if (!spec) continue;

        selected.push(label === 'Load/speed rating' ? `RATED ${spec.value}` : spec.value.toUpperCase());
        if (selected.length >= 4) break;
    }

    return selected;
}

function truncateText(value: string, maxLength: number) {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 3)}...`;
}

function formatFlyerModelLines(value: string) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    const maxLineLength = 28;

    const separatorMatch = normalized.match(/\s*[-–—|]\s*/);
    if (normalized.length > maxLineLength && separatorMatch?.index !== undefined) {
        const firstLine = normalized.slice(0, separatorMatch.index).trim();
        const secondLine = normalized.slice(separatorMatch.index + separatorMatch[0].length).trim();
        return [
            truncateText(firstLine, maxLineLength),
            truncateText(secondLine, maxLineLength),
        ].filter(Boolean);
    }

    return wrapText(normalized, maxLineLength, 2);
}

function wrapText(value: string, maxLineLength: number, maxLines: number) {
    const words = value.split(' ').filter(Boolean);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
        const candidate = currentLine ? `${currentLine} ${word}` : word;
        if (candidate.length <= maxLineLength) {
            currentLine = candidate;
            continue;
        }

        if (currentLine) lines.push(currentLine);
        currentLine = word;

        if (lines.length === maxLines - 1) break;
    }

    if (currentLine && lines.length < maxLines) lines.push(currentLine);

    if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
        const finalLineIndex = maxLines - 1;
        const finalLine = lines[finalLineIndex];
        if (finalLine) {
            lines[finalLineIndex] = truncateText(finalLine, maxLineLength);
        }
    }

    return lines.length > 0 ? lines : [truncateText(value, maxLineLength)];
}

function escapeSvgText(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

async function getBrandLogoBuffer() {
    const configuredPath = process.env.BRAND_LOGO_PATH;
    const logoPath = configuredPath
        ? path.resolve(path.join(__dirname, '..'), configuredPath)
        : DEFAULT_BRAND_LOGO_PATH;

    if (!fs.existsSync(logoPath)) return null;

    return sharp(logoPath)
        .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .resize(140, null, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
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

    if (!pageId) {
        console.log('📋 Facebook Page credentials missing. Skipping Facebook publish.');
        return;
    }

    const pageAccessToken = await getFacebookPageAccessToken(pageId);
    if (!pageAccessToken) {
        console.log('📋 Facebook Page access token unavailable. Skipping Facebook publish.');
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

async function getFacebookPageAccessToken(pageId: string) {
    if (process.env.FACEBOOK_PAGE_ACCESS_TOKEN) {
        return process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    }

    const metaAccessToken = process.env.META_ACCESS_TOKEN;
    if (!metaAccessToken) return null;

    const response = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
        params: {
            fields: 'access_token',
            access_token: metaAccessToken,
        },
    });

    return response.data.access_token as string | undefined;
}

function buildCarouselCaption(preparedDeals: PreparedDeal[]) {
    const intro = preparedDeals.length === 1
        ? 'Rebel Wheels and Tires deal just landed.'
        : `Rebel Wheels and Tires deal drop: ${preparedDeals.length} tire offers across different driving needs.`;

    const dealLines = preparedDeals.map((preparedDeal, index) => {
        const segmentLine = preparedDeal.deal.segment ? ` (${formatSegment(preparedDeal.deal.segment)})` : '';
        const regularLine = preparedDeal.regularPrice > 0
            ? `Regular: $${preparedDeal.regularPrice.toFixed(2)} / tire\nRebel price: $${preparedDeal.markedUpPrice.toFixed(2)} / tire (+ tax)\nDiscount: ${preparedDeal.discountPercent}% off`
            : `Rebel price: $${preparedDeal.markedUpPrice.toFixed(2)} / tire (+ tax)`;

        return `${index + 1}. ${preparedDeal.brand} ${preparedDeal.model}${segmentLine}\nSize: ${preparedDeal.tireSize}\n${regularLine}\nInventory: ${preparedDeal.setsCount} ${preparedDeal.setsCount === 1 ? 'set' : 'sets'} available locally.`;
    });

    const hashtags = selectHashtags(
        preparedDeals.map(preparedDeal => `${preparedDeal.brand} ${preparedDeal.model} ${preparedDeal.tireSize}`).join(' '),
        preparedDeals.map(preparedDeal => preparedDeal.deal.segment).filter(Boolean).join(' ')
    );

    return `${intro}\n\n${dealLines.join('\n\n')}\n\nSend Rebel Wheels and Tires a DM to lock in a set before it moves.\n\n${hashtags.join(' ')}`;
}

function formatSegment(segment: string) {
    const labels: Record<string, string> = {
        commuter: 'Commuter',
        'crossover-suv': 'Crossover / SUV',
        'truck-lt': 'Truck / LT',
        'off-road': 'Off-road',
    };

    return labels[segment] || segment;
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
