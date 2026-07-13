// src/notifier.ts
import axios from 'axios';
import type { GroupedDeals, TireDeal } from './analyzer';
import { isDryRun } from './config';

export async function sendTelegramAlert(groupedBySize: GroupedDeals) {
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

    if (topDealsAcrossSizes.length === 0) {
        console.log('📋 No qualified sets matching volume criteria found to transmit.');
        return;
    }

    topDealsAcrossSizes.sort((a, b) => b.discountPercent - a.discountPercent);

    // Cleaned up, professional data layout
    let message = `<b>Rebel Deal Digest — Daily Top Margins</b>\n`;
    message += `___________________________________\n\n`;

    for (const topDeal of topDealsAcrossSizes) {
        const safeBrand = topDeal.brand.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeModel = topDeal.model.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        message += `<b>${topDeal.scannedSize}</b>\n`;
        message += `• ${safeBrand} ${safeModel}\n`;
        message += `• Cost: $${topDeal.salePrice.toFixed(2)} (Reg: $${topDeal.baselinePrice.toFixed(2)})\n`;
        message += `• Margin: ${Math.round(topDeal.discountPercent)}% OFF\n`;
        message += `• Stock: ${topDeal.quantityAvailable} units\n\n`;
    }

    if (isDryRun()) {
        console.log('🧪 DRY_RUN enabled. Telegram digest skipped.');
        console.log(message);
        return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    
    await axios.post(url, {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
    
    console.log('📲 Telegram consolidated digest alert delivered successfully.');
}
