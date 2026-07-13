import 'dotenv/config'; 
import { chromium, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { sendTelegramAlert } from './notifier';
import { publishDailyDeals } from './instagram';
import {
    EXPANDED_TIRE_SIZES,
    type GroupedDeals,
    type TireDeal,
    groupQualifiedDeals,
    selectDealsForPosting,
} from './analyzer';

const STORAGE_STATE_PATH = path.join(__dirname, '../auth/state.json');
const DATA_OUTPUT_PATH = path.join(__dirname, '../data/raw_inventory.json');
const waitOptions = { waitUntil: 'load' as const, timeout: 60000 };

export async function runScraper() {
    const hasSession = fs.existsSync(STORAGE_STATE_PATH);
    const browser = await chromium.launch({ headless: true }); 
    const context = await browser.newContext(hasSession ? { storageState: STORAGE_STATE_PATH } : {});
    const page = await context.newPage();
    const masterInventoryList: TireDeal[] = [];

    try {
        // 1. Session Authentication & Language Bypass
        console.log('Validating session state on DT Tire Hub...');
        await page.goto('https://dttirehub.ca/touchettestorefront/touchette/en/login', waitOptions);

        // ✅ RESTORED: Click the English language selector if the modal pops up
        try {
            const englishButton = await page.waitForSelector('button[data-lang="en"]', { 
                timeout: 5000, 
                state: 'visible' 
            });
            if (englishButton) {
                console.log('🎯 Language selector modal detected. Selecting English variant...');
                await englishButton.click();
                // Brief wait to allow the modal backdrop animation layer to clear out of the DOM
                await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
            }
        } catch (e) {
            console.log('📋 Language modal didn’t appear or was already dismissed. Proceeding...');
        }

        const usernameSelector = 'input[name="j_username"]';
        const passwordSelector = 'input[name="j_password"]';

        if (await page.locator(usernameSelector).isVisible()) {
            console.log('Session expired. Processing form login...');
            await page.fill(usernameSelector, process.env.DT_TIRE_USER!);
            await page.fill(passwordSelector, process.env.DT_TIRE_PASS!);
            
            // ✅ UPDATED: Force the click down and handle the redirect fluidly
            console.log('Submitting credentials form entries...');
            await Promise.all([
                page.click('button[type="submit"]', { force: true }),
                page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).catch(() => {})
            ]);

            await context.storageState({ path: STORAGE_STATE_PATH });
            console.log('🔒 Secure session authenticated and cached successfully.');
        } else {
            console.log('✨ Re-used valid existing session cookie cache.');
        }

        // Continues cleanly into your catalog loops...
        console.log('🚀 Navigation settled. Entering master inventory size matrices...');

        for (const size of EXPANDED_TIRE_SIZES) {
            await page.goto(`https://dttirehub.ca/touchettestorefront/touchette/en/tireSearch/tire-size/search?tireSize=${encodeURIComponent(size)}&showOnlyOnSaleResults=true&sort=dealerPriceAsc`, waitOptions);
            const pageResults = await page.evaluate((currentSize) => {
                return Array.from(document.querySelectorAll('li.search-results__item')).map(card => {
                    const rawTitle = card.querySelector('h3.search-results__description')?.textContent?.trim() || 'Unknown Model';
                    const brandImg = card.querySelector('.search-results__manufacturer img') as HTMLImageElement;
                    const thumbImg = card.querySelector('img.c-product-image__img, .search-results__item-image img') as HTMLImageElement;
                    //const ajaxBtn = card.querySelector('.thumbnail-icons-container button') as HTMLButtonElement;
                    
                    const imageButton = card.querySelector('div.search-results__image div.thumbnail-icons-container button');
                    let ajaxUrl = imageButton ? imageButton.getAttribute('data-ajaxurl') || '' : '';
                    if (ajaxUrl && ajaxUrl.startsWith('/')) {
                        ajaxUrl = 'https://dttirehub.ca' + ajaxUrl;
                    }
                    
                    //const pContent = card.querySelector('.search-results__pdm-content-value')?.textContent || '';
                    const saleMatch = card.querySelector('.c-on-sale__price--reduced')?.textContent?.replace(/[^0-9.]/g, '');
                    const oldMatch = card.querySelector('.c-on-sale__price--old')?.textContent?.replace(/[^0-9.]/g, '');
                    
                    const titleParts = rawTitle.split(' ');
                    return {
                        scannedSize: currentSize,
                        brand: brandImg?.getAttribute('alt')?.replace(/brand/i, '').trim() || titleParts[0] || 'Unknown Brand',
                        model: titleParts.slice(1).join(' '),
                        salePrice: saleMatch ? parseFloat(saleMatch) : 0,
                        baselinePrice: oldMatch ? parseFloat(oldMatch) : 0,
                        discountPercent: Math.round(((parseFloat(oldMatch || '0') - parseFloat(saleMatch || '0')) / parseFloat(oldMatch || '1')) * 100),
                        quantityAvailable: parseInt(card.querySelector('.search-results__on-hand-item--local_count p')?.textContent?.replace(/[^0-9]/g, '') || '0', 10),
                        //ajaxUrl: ajaxBtn?.getAttribute('data-ajaxurl') || '',
                        ajaxUrl: ajaxUrl,
                        thumbUrl: thumbImg?.src || ''
                    };
                });
            }, size) as TireDeal[];
            masterInventoryList.push(...pageResults);
        }

        const groupedBySize: GroupedDeals = groupQualifiedDeals(masterInventoryList);

        fs.writeFileSync(DATA_OUTPUT_PATH, JSON.stringify(groupedBySize, null, 2));
        await sendTelegramAlert(groupedBySize); 

        const dealsToPost = selectDealsForPosting(groupedBySize);
        console.log(`📌 Selected ${dealsToPost.length} deal(s) for automatic social posting.`);

        for (const deal of dealsToPost) {
            const finalImage = await resolveHighResImage(page, deal);
            await publishDailyDeals({ ...deal, highResImageUrl: finalImage, size: deal.scannedSize, price: deal.salePrice });
        }
    } finally {
        await browser.close();
    }
}

async function resolveHighResImage(page: Page, deal: TireDeal) {
    let finalImage = deal.thumbUrl;
    if (!deal.ajaxUrl) return finalImage;

    await page.goto(deal.ajaxUrl, waitOptions);
    await page.waitForSelector('img', { timeout: 8000 });

    let highResUrl = await page.evaluate(() => {
        const carouselImg = document.querySelector('.image-gallery img[src*="600-conversionFormat"]') ||
            document.querySelector('.js-gallery-image img[src*="600-conversionFormat"]') ||
            document.querySelector('.owl-carousel img[src*="600-conversionFormat"]');

        if (carouselImg) return carouselImg.getAttribute('src') || carouselImg.getAttribute('data-src') || '';

        const anyHighResImg = Array.from(document.querySelectorAll('img[src*="600-conversionFormat"]'))
            .find(img => {
                const alt = (img.getAttribute('alt') || '').toLowerCase();
                const src = (img.getAttribute('src') || '').toLowerCase();
                return !alt.includes('logo') && !alt.includes('brand') && !src.includes('logo');
            });

        if (anyHighResImg) return anyHighResImg.getAttribute('src') || anyHighResImg.getAttribute('data-src') || '';

        const layoutFallback = document.querySelector('.image-gallery img') || document.querySelector('.js-gallery-image img');
        return layoutFallback ? layoutFallback.getAttribute('src') || layoutFallback.getAttribute('data-src') || '' : '';
    });

    console.log(`📸 [DEBUG] Isolated tire graphic image string: "${highResUrl}"`);

    if (highResUrl) {
        if (highResUrl.startsWith('/')) highResUrl = 'https://dttirehub.ca' + highResUrl;
        finalImage = highResUrl;
        console.log(`✅ [DEBUG] Successfully mapped verified High-Res layout configuration: ${highResUrl}`);
    } else {
        console.log('⚠️ [DEBUG] No precise image configurations recovered inside snippet structure.');
    }

    return finalImage;
}
