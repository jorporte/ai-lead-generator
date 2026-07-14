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
} from './analyzer';

const STORAGE_STATE_PATH = path.join(__dirname, '../auth/state.json');
const DATA_OUTPUT_PATH = path.join(__dirname, '../data/raw_inventory.json');
const EXTRACTION_DEBUG_OUTPUT_PATH = path.join(__dirname, '../data/extraction_debug.json');
const waitOptions = { waitUntil: 'domcontentloaded' as const, timeout: 60000 };
const SEARCH_RESULTS_EXTRACTION_SCRIPT = `
currentSize => {
    const cleanText = value => (value || '').replace(/\\s+/g, ' ').trim();
    const cleanPrice = value => cleanText(value).replace(/[^0-9.]/g, '');
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
        const rawTitle = cleanText(card.querySelector('h3.search-results__description') && card.querySelector('h3.search-results__description').textContent) || 'Unknown Model';
        const brandImg = card.querySelector('.search-results__manufacturer img');
        const thumbImg = card.querySelector('img.c-product-image__img, .search-results__item-image img');
        const imageButton = card.querySelector('div.search-results__image div.thumbnail-icons-container button');
        let ajaxUrl = imageButton ? imageButton.getAttribute('data-ajaxurl') || '' : '';
        if (ajaxUrl && ajaxUrl.startsWith('/')) {
            ajaxUrl = 'https://dttirehub.ca' + ajaxUrl;
        }

        const saleMatch = cleanPrice(card.querySelector('.c-on-sale__price--reduced') && card.querySelector('.c-on-sale__price--reduced').textContent);
        const oldMatch = cleanPrice(card.querySelector('.c-on-sale__price--old') && card.querySelector('.c-on-sale__price--old').textContent);
        const titleParts = rawTitle.split(' ');
        const productPath = ajaxUrl ? new URL(ajaxUrl, window.location.origin).pathname : '';
        const productCode = productPath.split('/').filter(Boolean).pop() || '';

        return {
            scannedSize: currentSize,
            brand: (brandImg && brandImg.getAttribute('alt') ? brandImg.getAttribute('alt').replace(/brand/i, '').trim() : '') || titleParts[0] || 'Unknown Brand',
            model: titleParts.slice(1).join(' '),
            salePrice: saleMatch ? parseFloat(saleMatch) : 0,
            baselinePrice: oldMatch ? parseFloat(oldMatch) : 0,
            discountPercent: Math.round(((parseFloat(oldMatch || '0') - parseFloat(saleMatch || '0')) / parseFloat(oldMatch || '1')) * 100),
            quantityAvailable: parseInt((card.querySelector('.search-results__on-hand-item--local_count p') && card.querySelector('.search-results__on-hand-item--local_count p').textContent || '').replace(/[^0-9]/g, '') || '0', 10),
            ajaxUrl,
            thumbUrl: thumbImg && thumbImg.src ? thumbImg.src : '',
            extraction: {
                rawTitle,
                rawCardText: cleanText(card.textContent),
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
            await gotoPage(page, `https://dttirehub.ca/touchettestorefront/touchette/en/tireSearch/tire-size/search?tireSize=${encodeURIComponent(size)}&showOnlyOnSaleResults=true&sort=dealerPriceAsc`, `${size} search page`);
            const pageResults = await page.evaluate(createSearchResultsExtractor(), size) as RawExtractionDebug[];

            const enrichedPageResults = pageResults.map(addCustomerSpecs);

            logSizeScanSummary(size, enrichedPageResults);
            extractionDebugList.push(...enrichedPageResults);
            masterInventoryList.push(...enrichedPageResults.map(stripExtractionDebug));
        }

        const groupedBySize: GroupedDeals = groupQualifiedDeals(masterInventoryList);
        logInventorySummary(masterInventoryList, groupedBySize);

        fs.writeFileSync(DATA_OUTPUT_PATH, JSON.stringify(groupedBySize, null, 2));
        fs.writeFileSync(EXTRACTION_DEBUG_OUTPUT_PATH, JSON.stringify(extractionDebugList, null, 2));
        console.log(`🧾 Wrote extraction debug JSON: ${EXTRACTION_DEBUG_OUTPUT_PATH}`);
        await sendTelegramAlert(groupedBySize); 

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
    return new Function('currentSize', `return (${SEARCH_RESULTS_EXTRACTION_SCRIPT})(currentSize);`) as unknown as (currentSize: string) => RawExtractionDebug[];
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

function logSizeScanSummary(size: string, deals: TireDeal[]) {
    const withPrice = deals.filter(deal => deal.salePrice > 0).length;
    const withStock = deals.filter(deal => deal.quantityAvailable > 0).length;
    const qualified = deals.filter(deal => deal.salePrice > 0 && deal.quantityAvailable >= 4 && deal.discountPercent >= 10).length;
    const maxStock = Math.max(0, ...deals.map(deal => deal.quantityAvailable));
    const maxDiscount = Math.max(0, ...deals.map(deal => deal.discountPercent));

    console.log(`🔎 ${size}: ${deals.length} cards, ${withPrice} priced, ${withStock} stocked, ${qualified} qualified, max stock ${maxStock}, max discount ${maxDiscount}%`);
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
