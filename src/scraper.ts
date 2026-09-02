import 'dotenv/config'; 
import { chromium, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { sendTelegramAlert } from './notifier';
import { publishDailyDeals } from './instagram';
import { isBrowserHeadless, isDevMode, isDryRun } from './config';
import {
    EXPANDED_TIRE_SIZES,
    type CustomerSpec,
    type GroupedDeals,
    type TireDeal,
    groupQualifiedDeals,
    selectDealsForPosting,
    selectChangeoverDeals,
} from './analyzer';

const STORAGE_STATE_PATH = path.join(__dirname, '../auth/state.json');
const DATA_OUTPUT_PATH = path.join(__dirname, '../data/raw_inventory.json');
const CHANGEOVER_OUTPUT_PATH = path.join(__dirname, '../data/changeover_inventory.json');
const EXTRACTION_DEBUG_OUTPUT_PATH = path.join(__dirname, '../data/extraction_debug.json');
const waitOptions = { waitUntil: 'domcontentloaded' as const, timeout: 60000 };
const SEARCH_RESULTS_EXTRACTION_SCRIPT = `
({ currentSize, searchUrl }) => {
    const cleanText = value => (value || '').replace(/\\s+/g, ' ').trim();
    const cleanPrice = value => cleanText(value).replace(/[^0-9.]/g, '');
    const parsePrice = value => {
        const parsed = parseFloat((value || '').replace(/,/g, ''));
        return Number.isFinite(parsed) ? parsed : 0;
    };
    const extractVisibleLines = root => cleanText(root.textContent)
        .split(/(?=[A-Z][A-Za-z /-]+:)|\\n/)
        .map(line => cleanText(line))
        .filter(Boolean);
    const extractSpecs = root => {
        const specs = [];
        const addSpec = (label, value) => {
            const cleanLabel = cleanText(label).replace(/:$/, '');
            const cleanValue = cleanText(value);
            if (!cleanLabel || !cleanValue || cleanLabel === cleanValue) return;
            if (specs.some(spec => spec.label === cleanLabel && spec.value === cleanValue)) return;
            specs.push({ label: cleanLabel, value: cleanValue });
        };

        root.querySelectorAll('tr').forEach(row => {
            const cells = Array.from(row.querySelectorAll('th, td')).map(cell => cleanText(cell.textContent));
            if (cells.length >= 2) addSpec(cells[0], cells.slice(1).join(' '));
        });

        root.querySelectorAll('dt').forEach(term => {
            let valueElement = term.nextElementSibling;
            while (valueElement && valueElement.tagName.toLowerCase() !== 'dd') {
                valueElement = valueElement.nextElementSibling;
            }
            addSpec(term.textContent, valueElement && valueElement.textContent);
        });

        root.querySelectorAll('[class*="pdm"], [class*="spec"], [class*="attribute"], [class*="feature"]').forEach(element => {
            const text = cleanText(element.textContent);
            const colonMatch = text.match(/^([^:]{2,40}):\\s*(.{1,80})$/);
            if (colonMatch) addSpec(colonMatch[1], colonMatch[2]);
        });

        return specs;
    };

    return Array.from(document.querySelectorAll('li.search-results__item')).map(card => {
        const rawCardText = cleanText(card.textContent);
        const rawTitle = cleanText(card.querySelector('h3.search-results__description') && card.querySelector('h3.search-results__description').textContent) || 'Unknown Model';
        const brandImg = card.querySelector('.search-results__manufacturer img');
        const thumbImg = card.querySelector('img.c-product-image__img, .search-results__item-image img');
        const imageButton = card.querySelector('div.search-results__image div.thumbnail-icons-container button');
        let ajaxUrl = imageButton ? imageButton.getAttribute('data-ajaxurl') || '' : '';
        if (ajaxUrl && ajaxUrl.startsWith('/')) {
            ajaxUrl = 'https://dttirehub.ca' + ajaxUrl;
        }

        const productAnchor = card.querySelector('a[href*="/p/tire/"]');
        let productUrl = productAnchor ? productAnchor.getAttribute('href') || '' : ajaxUrl;
        if (productUrl && productUrl.startsWith('/')) {
            productUrl = 'https://dttirehub.ca' + productUrl;
        }

        const saleMatch = cleanPrice(card.querySelector('.c-on-sale__price--reduced') && card.querySelector('.c-on-sale__price--reduced').textContent);
        const oldMatch = cleanPrice(card.querySelector('.c-on-sale__price--old') && card.querySelector('.c-on-sale__price--old').textContent);
        const portalPricingMatch = rawCardText.match(/\\bP\\s*\\$([0-9,.]+)(?:\\s+\\$[0-9,.]+)?\\s+D\\s*([0-9.]+)%\\s+M\\s*\\$[0-9,.]+/i);
        const msrpMatch = rawCardText.match(/\\$([0-9,.]+)\\s*MSRP\\b/i);
        const isOnSale = /\\bOn sale\\b/i.test(rawCardText) || Boolean(card.querySelector('.c-on-sale__price--reduced'));
        const isChangeover = /\\bchange\\s*-?\\s*over\\b/i.test(rawCardText);
        const selectorSalePrice = parsePrice(saleMatch);
        const selectorBaselinePrice = parsePrice(oldMatch);
        const portalDealerPrice = parsePrice(portalPricingMatch && portalPricingMatch[1]);
        const portalDiscountPercent = parsePrice(portalPricingMatch && portalPricingMatch[2]);
        const msrpPrice = parsePrice(msrpMatch && msrpMatch[1]);
        const salePrice = isChangeover ? (portalDealerPrice || selectorSalePrice) : selectorSalePrice;
        const baselinePrice = isChangeover ? (msrpPrice || selectorBaselinePrice) : selectorBaselinePrice;
        const calculatedDiscount = baselinePrice > 0 && salePrice > 0
            ? Math.round(((baselinePrice - salePrice) / baselinePrice) * 100)
            : 0;
        const discountPercent = isChangeover && portalDiscountPercent > 0
            ? portalDiscountPercent
            : calculatedDiscount;
        const localStockMatch = rawCardText.match(/([0-9]+)\\s+Available locally/i);
        const warehouseStockMatch = rawCardText.match(/([0-9]+)\\s+Available in other warehouses/i);
        const localQuantity = parseInt(localStockMatch && localStockMatch[1] || '0', 10);
        const warehouseQuantity = parseInt(warehouseStockMatch && warehouseStockMatch[1] || '0', 10);
        const isOutOfStockInRegion = /Out of stock in region/i.test(rawCardText);
        const availability = isOutOfStockInRegion
            ? 'Out of stock in region - check portal options'
            : localQuantity + ' local, ' + warehouseQuantity + ' in other warehouses';
        const availableQuantity = isChangeover
            ? localQuantity + warehouseQuantity
            : localQuantity || parseInt((card.querySelector('.search-results__on-hand-item--local_count p') && card.querySelector('.search-results__on-hand-item--local_count p').textContent || '').replace(/[^0-9]/g, '') || '0', 10);
        const titleParts = rawTitle.split(' ');
        const productPath = productUrl ? new URL(productUrl, window.location.origin).pathname : '';
        const productCode = productPath.split('/').filter(Boolean).pop() || '';
        const skuMatch = rawCardText.match(/\\bSKU:\\s*([^\\s]+)/i);
        const sku = skuMatch && skuMatch[1] || '';

        return {
            scannedSize: currentSize,
            brand: (brandImg && brandImg.getAttribute('alt') ? brandImg.getAttribute('alt').replace(/brand/i, '').trim() : '') || titleParts[0] || 'Unknown Brand',
            model: titleParts.slice(1).join(' '),
            salePrice,
            baselinePrice,
            discountPercent,
            quantityAvailable: availableQuantity,
            ajaxUrl,
            productUrl: productUrl || ajaxUrl,
            searchUrl,
            productCode,
            sku,
            thumbUrl: thumbImg && thumbImg.src ? thumbImg.src : '',
            isOnSale,
            isChangeover,
            availability,
            extraction: {
                rawTitle,
                rawCardText,
                visibleLines: extractVisibleLines(card),
                specs: extractSpecs(card),
                productPath,
                productCode,
            },
        };
    });
}
`;

type ExtractedSpec = CustomerSpec;

type RawExtractionDebug = TireDeal & {
    extraction: {
        rawTitle: string;
        rawCardText: string;
        visibleLines: string[];
        specs: ExtractedSpec[];
        customerSpecs?: ExtractedSpec[];
        productPath: string;
        productCode: string;
    };
};

export async function runScraper() {
    ensureRuntimeDirectories();

    const hasSession = fs.existsSync(STORAGE_STATE_PATH);
    const headless = isBrowserHeadless();
    console.log(`🧭 Browser mode: ${headless ? 'headless' : 'visual'}`);
    const browser = await chromium.launch({ headless }); 
    const context = await browser.newContext(hasSession ? { storageState: STORAGE_STATE_PATH } : {});
    const page = await context.newPage();
    const masterInventoryList: TireDeal[] = [];
    const changeoverInventoryList: TireDeal[] = [];
    const extractionDebugList: RawExtractionDebug[] = [];

    try {
        // 1. Session Authentication & Language Bypass
        console.log('Validating session state on DT Tire Hub...');
        await gotoPage(page, 'https://dttirehub.ca/touchettestorefront/touchette/en/login', 'login page');

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
                await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
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
                page.waitForNavigation(waitOptions).catch(() => {})
            ]);

            await context.storageState({ path: STORAGE_STATE_PATH });
            console.log('🔒 Secure session authenticated and cached successfully.');
        } else {
            console.log('✨ Re-used valid existing session cookie cache.');
        }

        // Continues cleanly into your catalog loops...
        const tireSizesToScan = getTireSizesForRun();
        console.log(`🚀 Navigation settled. Entering inventory size matrix for ${tireSizesToScan.length} tire ${tireSizesToScan.length === 1 ? 'size' : 'sizes'}...`);

        for (const size of tireSizesToScan) {
            const searchUrl = buildSearchUrl(size);
            await gotoPage(page, searchUrl, `${size} catalog search page`);
            const catalogResults = (await extractSearchResults(page, size, searchUrl))
                .map(addCustomerSpecs);
            const saleResults = catalogResults
                .filter(deal => deal.isOnSale && !deal.isChangeover);
            const changeoverResults = catalogResults
                .filter(deal => deal.isChangeover);

            logCatalogScanSummary(size, catalogResults, saleResults, changeoverResults);
            extractionDebugList.push(...catalogResults);
            masterInventoryList.push(...saleResults.map(stripExtractionDebug));
            changeoverInventoryList.push(...changeoverResults.map(stripExtractionDebug));
        }

        const groupedBySize: GroupedDeals = groupQualifiedDeals(masterInventoryList);
        const changeoverDeals = selectChangeoverDeals(changeoverInventoryList);
        logInventorySummary(masterInventoryList, groupedBySize);
        console.log(`⚡ Changeover scan summary: ${changeoverDeals.length} unique deal(s) found.`);

        fs.writeFileSync(DATA_OUTPUT_PATH, JSON.stringify(groupedBySize, null, 2));
        fs.writeFileSync(CHANGEOVER_OUTPUT_PATH, JSON.stringify(changeoverDeals, null, 2));
        fs.writeFileSync(EXTRACTION_DEBUG_OUTPUT_PATH, JSON.stringify(extractionDebugList, null, 2));
        console.log(`🧾 Wrote extraction debug JSON: ${EXTRACTION_DEBUG_OUTPUT_PATH}`);
        await sendTelegramAlert(groupedBySize, changeoverDeals);

        const dealsToPost = selectDealsForPosting(groupedBySize);
        console.log(`📌 Selected ${dealsToPost.length} deal(s) for automatic social posting.`);

        const hydratedDeals: TireDeal[] = [];

        for (const deal of dealsToPost) {
            console.log(`🎯 Selected ${deal.segment || 'general'} deal: ${deal.scannedSize} ${deal.brand} ${deal.model} at $${deal.salePrice.toFixed(2)} (${deal.discountPercent}% off, ${deal.quantityAvailable} units).`);
            const finalImage = await resolveHighResImage(page, deal);
            if (isDryRun()) {
                console.log(`🧪 DRY_RUN enabled. Resolved image candidate: ${finalImage || 'none'}`);
            }
            hydratedDeals.push({ ...deal, highResImageUrl: finalImage });
        }

        if (hydratedDeals.length > 0) {
            await publishDailyDeals(hydratedDeals);
        }
    } finally {
        await browser.close();
    }
}

function ensureRuntimeDirectories() {
    fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
    fs.mkdirSync(path.dirname(DATA_OUTPUT_PATH), { recursive: true });
    fs.mkdirSync(path.dirname(CHANGEOVER_OUTPUT_PATH), { recursive: true });
    fs.mkdirSync(path.dirname(EXTRACTION_DEBUG_OUTPUT_PATH), { recursive: true });
}

function stripExtractionDebug(rawDeal: RawExtractionDebug): TireDeal {
    const { extraction, ...deal } = rawDeal;
    if (!extraction.customerSpecs) return deal;
    return { ...deal, customerSpecs: extraction.customerSpecs };
}

function addCustomerSpecs(rawDeal: RawExtractionDebug): RawExtractionDebug {
    return {
        ...rawDeal,
        extraction: {
            ...rawDeal.extraction,
            customerSpecs: buildCustomerSpecs(rawDeal),
        },
    };
}

function buildCustomerSpecs(rawDeal: RawExtractionDebug): ExtractedSpec[] {
    const specs = rawDeal.extraction.specs;
    const rawText = rawDeal.extraction.rawCardText;
    const customerSpecs: ExtractedSpec[] = [];

    const addSpec = (label: string, value: string) => {
        if (!label || isMissingSpecValue(value)) return;
        if (customerSpecs.some(spec => spec.label === label && spec.value === value)) return;
        customerSpecs.push({ label, value });
    };

    const tireType = inferCustomerTireType(rawDeal.model, rawText);
    if (tireType) addSpec('Tire type', tireType);

    const serviceRating = formatServiceRating(findSpecValue(specs, 'Service desc.'));
    if (serviceRating) addSpec('Load/speed rating', serviceRating);

    const studdingInfo = findSpecValue(specs, 'Studding info.');
    if (studdingInfo === 'Studdable') addSpec('Winter traction', 'Can be studded');
    if (studdingInfo === 'Pre-studded') addSpec('Winter traction', 'Factory studded');

    const treadDesign = findSpecValue(specs, 'Tread design');
    if (!isMissingSpecValue(treadDesign)) addSpec('Tread pattern', `${treadDesign} tread`);

    const sidewall = formatSidewall(findSpecValue(specs, 'Sidewall'));
    if (sidewall) addSpec('Sidewall', sidewall);

    const loadRange = findSpecValue(specs, 'Load range');
    if (loadRange === 'XL') addSpec('Load strength', 'Extra load rated');
    if (loadRange === 'SL') addSpec('Load strength', 'Standard load rated');
    if (loadRange === 'D') addSpec('Load strength', 'Heavy duty load range D');

    const maxLoad = findSpecValue(specs, 'Max. load (single)');
    if (maxLoad && !isMissingSpecValue(maxLoad)) addSpec('Max load', `Carries up to ${formatSpecNumber(maxLoad)} per tire`);

    const maxSpeed = findSpecValue(specs, 'Max. cert. speed');
    if (maxSpeed && !isMissingSpecValue(maxSpeed)) addSpec('Speed capability', `Certified up to ${formatSpecNumber(maxSpeed)}`);

    return customerSpecs;
}

function inferCustomerTireType(model: string, rawText: string) {
    const text = `${model} ${rawText}`.toLowerCase();
    if (text.includes('winter') || text.includes('ice and snow')) return 'Winter ready';
    if (text.includes('all-season') || text.includes('all season')) return 'All season';
    if (text.includes('all terrain') || text.includes('highway terrain')) return 'Truck and SUV terrain';
    if (text.includes('touring')) return 'Comfort touring';
    return null;
}

function findSpecValue(specs: ExtractedSpec[], label: string) {
    return specs.find(spec => spec.label.trim() === label)?.value?.trim();
}

function formatServiceRating(value?: string) {
    const match = value?.trim().match(/^(\d{2,3}[A-Z])/i);
    return match?.[1] ? match[1].toUpperCase() : null;
}

function isMissingSpecValue(value?: string) {
    return !value || /^[-\s]+$/.test(value);
}

function formatSidewall(value?: string) {
    const normalized = value?.trim().toUpperCase();
    const sidewalls: Record<string, string> = {
        BSW: 'Black sidewall',
        BL: 'Black sidewall',
        OWL: 'Outlined white lettering',
        RWL: 'Raised white lettering',
        WSW: 'White sidewall',
        VSB: 'Vertical serrated band',
    };

    return normalized ? sidewalls[normalized] : null;
}

function formatSpecNumber(value: string) {
    return value
        .replace(/\.0(?=[a-z])/gi, '')
        .replace(/\.0\b/g, '')
        .replace(/([0-9])([a-z])/gi, '$1 $2');
}

function createSearchResultsExtractor() {
    return new Function('input', `return (${SEARCH_RESULTS_EXTRACTION_SCRIPT})(input);`) as unknown as (input: { currentSize: string; searchUrl: string }) => RawExtractionDebug[];
}

async function extractSearchResults(page: Page, currentSize: string, searchUrl: string) {
    return await page.evaluate(createSearchResultsExtractor(), { currentSize, searchUrl }) as RawExtractionDebug[];
}

function buildSearchUrl(size: string) {
    const params = new URLSearchParams({
        tireSize: size,
        sort: 'dealerPriceAsc',
    });

    return `https://dttirehub.ca/touchettestorefront/touchette/en/tireSearch/tire-size/search?${params.toString()}`;
}

function getTireSizesForRun(): string[] {
    if (!isDevMode()) return EXPANDED_TIRE_SIZES;
    if (EXPANDED_TIRE_SIZES.length === 0) {
        throw new Error('DEV_MODE cannot select a tire size because EXPANDED_TIRE_SIZES is empty.');
    }

    const randomSize = EXPANDED_TIRE_SIZES[Math.floor(Math.random() * EXPANDED_TIRE_SIZES.length)] as string;
    console.log(`🛠️ DEV_MODE enabled. Scanning one random tire size: ${randomSize}`);
    return [randomSize];
}

function logCatalogScanSummary(size: string, catalog: TireDeal[], sales: TireDeal[], changeovers: TireDeal[]) {
    const qualifiedSales = sales.filter(deal => deal.salePrice > 0 && deal.quantityAvailable >= 4 && deal.discountPercent >= 10).length;
    const linkedChangeovers = changeovers.filter(deal => Boolean(deal.productUrl || deal.ajaxUrl)).length;

    console.log(`🔎 ${size}: ${catalog.length} catalog cards, ${sales.length} sale cards (${qualifiedSales} qualified), ${changeovers.length} changeover deal(s) (${linkedChangeovers} linked).`);
}

function logInventorySummary(allDeals: TireDeal[], groupedBySize: GroupedDeals) {
    const qualifiedCount = Object.values(groupedBySize).reduce((sum, deals) => sum + deals.length, 0);
    const sizesWithQualifiedDeals = Object.keys(groupedBySize).length;
    const totalStocked = allDeals.filter(deal => deal.quantityAvailable > 0).length;
    const totalPriced = allDeals.filter(deal => deal.salePrice > 0).length;

    console.log(`📊 Inventory scan summary: ${allDeals.length} total cards, ${totalPriced} priced, ${totalStocked} stocked, ${qualifiedCount} qualified across ${sizesWithQualifiedDeals} sizes.`);
}

async function resolveHighResImage(page: Page, deal: TireDeal) {
    let finalImage = deal.thumbUrl;
    if (!deal.ajaxUrl) return finalImage;

    await gotoPage(page, deal.ajaxUrl, `${deal.brand} ${deal.model} image page`);
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

async function gotoPage(page: Page, url: string, label: string) {
    try {
        await page.goto(url, waitOptions);
    } catch (error: any) {
        console.log(`⚠️ Timed out loading ${label}; retrying with a fresh navigation...`);
        await page.goto(url, waitOptions);
    }
}
