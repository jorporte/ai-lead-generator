// src/notifier.ts
import axios from 'axios';
import type { GroupedDeals, TireDeal } from './analyzer';
import { isDryRun } from './config';

const MAX_TELEGRAM_MESSAGE_LENGTH = 3800;

export async function sendTelegramAlert(groupedBySize: GroupedDeals, changeoverDeals: TireDeal[] = []) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!token || !chatId) {
        console.error('⚠️ Missing Telegram credentials in configuration environment flags.');
        return;
    }

    const topDealsAcrossSizes: TireDeal[] = [];
    
    for (const size in groupedBySize) {
        const topDealForSize = groupedBySize[size]?.[0];
        if (topDealForSize) {
            topDealsAcrossSizes.push(topDealForSize);
        }
    }

    if (topDealsAcrossSizes.length === 0 && changeoverDeals.length === 0) {
        console.log('📋 No qualified sets or changeover deals found to transmit.');
        return;
    }

    topDealsAcrossSizes.sort((a, b) => b.discountPercent - a.discountPercent);
    const messages = [
        ...buildChangeoverMessages(changeoverDeals),
        ...buildDailyDigestMessages(topDealsAcrossSizes),
    ];

    if (isDryRun()) {
        console.log('🧪 DRY_RUN enabled. Telegram messages skipped.');
        messages.forEach(message => console.log(message));
        return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    for (const message of messages) {
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    }

    console.log(`📲 Delivered ${messages.length} Telegram alert message(s) successfully.`);
}

function buildChangeoverMessages(changeoverDeals: TireDeal[]) {
    if (changeoverDeals.length === 0) return [];

    const blocks = changeoverDeals.map(deal => {
        const lines = [
            `<b>${escapeHtml(deal.scannedSize)} - ${escapeHtml(deal.brand)} ${escapeHtml(deal.model)}</b>`,
            deal.sku || deal.productCode ? `• SKU: ${escapeHtml(deal.sku || deal.productCode || '')}` : '',
            deal.salePrice > 0 ? `• Dealer cost: $${deal.salePrice.toFixed(2)}` : '• Dealer cost: Check portal',
            deal.baselinePrice > 0 ? `• MSRP: $${deal.baselinePrice.toFixed(2)}` : '',
            deal.discountPercent > 0 ? `• Portal discount: ${formatPercent(deal.discountPercent)}%` : '',
            deal.availability ? `• Availability: ${escapeHtml(deal.availability)}` : '',
        ].filter(Boolean);

        const dealUrl = buildPortalSkuSearchUrl(deal.sku)
            || deal.searchUrl
            || deal.productUrl
            || deal.ajaxUrl;
        if (dealUrl) lines.push(`• <a href="${escapeHtml(dealUrl)}">Open deal in DT Tire Hub</a>`);

        return lines.join('\n');
    });

    return chunkMessage('<b>⚡ CHANGEOVER ALERT - ACT FAST</b>', blocks);
}

function buildDailyDigestMessages(topDealsAcrossSizes: TireDeal[]) {
    if (topDealsAcrossSizes.length === 0) return [];

    const blocks = topDealsAcrossSizes.map(topDeal => {
        return [
            `<b>${escapeHtml(topDeal.scannedSize)}</b>`,
            `• ${escapeHtml(topDeal.brand)} ${escapeHtml(topDeal.model)}`,
            `• Cost: $${topDeal.salePrice.toFixed(2)} (Reg: $${topDeal.baselinePrice.toFixed(2)})`,
            `• Margin: ${Math.round(topDeal.discountPercent)}% OFF`,
            `• Stock: ${topDeal.quantityAvailable} units`,
        ].join('\n');
    });

    return chunkMessage('<b>Rebel Deal Digest - Daily Top Margins</b>', blocks);
}

function chunkMessage(header: string, blocks: string[]) {
    const messages: string[] = [];
    let current = `${header}\n___________________________________\n\n`;

    for (const block of blocks) {
        const candidate = `${current}${block}\n\n`;
        if (candidate.length > MAX_TELEGRAM_MESSAGE_LENGTH && current.length > header.length) {
            messages.push(current.trim());
            current = `${header} (continued)\n___________________________________\n\n`;
        }
        current += `${block}\n\n`;
    }

    if (current.trim()) messages.push(current.trim());
    return messages;
}

function escapeHtml(value: string) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatPercent(value: number) {
    return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function buildPortalSkuSearchUrl(sku?: string) {
    if (!sku) return null;

    const params = new URLSearchParams({
        tireSize: '',
        _showRearTireSize: 'on',
        rearTireSize: '',
        sku,
        manufacturer: '',
        model: '',
        modelCode: '',
        description: '',
        season: 'ALL',
        _showOnlyOnSaleResults: 'on',
        searchQuery: '',
        sort: 'relevance',
    });

    return `https://dttirehub.ca/touchettestorefront/touchette/en/tireSearch/tire-size/search?${params.toString()}`;
}
