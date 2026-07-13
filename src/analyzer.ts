export type CustomerSegment = 'commuter' | 'crossover-suv' | 'truck-lt' | 'off-road';

export type TireDeal = {
    scannedSize: string;
    brand: string;
    model: string;
    salePrice: number;
    baselinePrice: number;
    discountPercent: number;
    quantityAvailable: number;
    ajaxUrl: string;
    thumbUrl: string;
    highResImageUrl?: string;
    segment?: CustomerSegment;
    leadScore?: number;
};

export type GroupedDeals = Record<string, TireDeal[]>;

const MINIMUM_SET_QUANTITY = Number(process.env.MIN_DEAL_QUANTITY || 4);
const MINIMUM_DISCOUNT_PERCENT = Number(process.env.MIN_DISCOUNT_PERCENT || 10);
const MAX_POSTS_PER_RUN = Number(process.env.MAX_POSTS_PER_RUN || process.env.MAX_CAROUSEL_ITEMS || 4);

export const CORE_TIRE_SIZES = [
    '195/65r15',
    '205/55r16',
    '215/55r17',
    '225/65r17',
    '265/70r17',
    'LT285/70R17',
    'LT275/65R20',
    '35X12.50R17',
    '35X12.50R20',
];

export const EXPANDED_TIRE_SIZES = [
    ...CORE_TIRE_SIZES,
    '205/60r16',
    '215/60r16',
    '225/60r17',
    '235/65r17',
    '235/60r18',
    '225/55r18',
    '235/55r18',
    '255/55r20',
    '275/55r20',
    'LT275/70R18',
    'LT285/65R18',
    'LT275/65R18',
];

export function segmentForSize(size: string): CustomerSegment {
    const normalized = size.toUpperCase();

    if (normalized.startsWith('35X')) return 'off-road';
    if (normalized.startsWith('LT') || normalized.includes('/70R') || normalized.includes('/65R20')) return 'truck-lt';
    if (normalized.includes('17') || normalized.includes('18') || normalized.includes('20')) return 'crossover-suv';
    return 'commuter';
}

export function calculateLeadScore(deal: TireDeal): number {
    const availableSets = Math.floor(deal.quantityAvailable / 4);
    const discountScore = Math.max(deal.discountPercent, 0) * 3;
    const priceScore = deal.salePrice > 0 ? Math.max(120 - deal.salePrice, 0) * 0.3 : 0;
    const volumeScore = Math.min(availableSets, 5) * 8;

    return Math.round(discountScore + priceScore + volumeScore);
}

export function groupQualifiedDeals(deals: TireDeal[]): GroupedDeals {
    const grouped: GroupedDeals = {};

    for (const deal of deals) {
        if (!isQualifiedDeal(deal)) continue;

        const enrichedDeal = {
            ...deal,
            segment: segmentForSize(deal.scannedSize),
            leadScore: calculateLeadScore(deal),
        };

        const sizeDeals = grouped[deal.scannedSize] ?? [];
        sizeDeals.push(enrichedDeal);
        grouped[deal.scannedSize] = sizeDeals;
    }

    for (const size of Object.keys(grouped)) {
        grouped[size]?.sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
    }

    return grouped;
}

export function selectDealsForPosting(groupedDeals: GroupedDeals): TireDeal[] {
    const allQualified = Object.values(groupedDeals).flat();
    if (allQualified.length === 0) return [];

    const dealsBySegment = new Map<CustomerSegment, TireDeal[]>();
    for (const deal of allQualified) {
        const segment = deal.segment ?? segmentForSize(deal.scannedSize);
        const current = dealsBySegment.get(segment) ?? [];
        current.push(deal);
        dealsBySegment.set(segment, current);
    }

    const selected: TireDeal[] = [];
    const randomizedSegments = shuffle(Array.from(dealsBySegment.keys()));

    for (const segment of randomizedSegments) {
        const segmentDeals = dealsBySegment.get(segment) ?? [];
        const weightedPool = buildWeightedPool(segmentDeals);
        const randomPick = weightedPool[Math.floor(Math.random() * weightedPool.length)];
        if (randomPick) selected.push(randomPick);
        if (selected.length >= MAX_POSTS_PER_RUN) break;
    }

    return selected;
}

function isQualifiedDeal(deal: TireDeal): boolean {
    return deal.quantityAvailable >= MINIMUM_SET_QUANTITY
        && deal.salePrice > 0
        && deal.discountPercent >= MINIMUM_DISCOUNT_PERCENT
        && Boolean(deal.brand)
        && Boolean(deal.model);
}

function buildWeightedPool(deals: TireDeal[]): TireDeal[] {
    const sortedDeals = [...deals].sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
    const pool: TireDeal[] = [];

    sortedDeals.forEach((deal, index) => {
        const weight = Math.max(1, 5 - index);
        for (let i = 0; i < weight; i += 1) {
            pool.push(deal);
        }
    });

    return pool;
}

function shuffle<T>(items: T[]): T[] {
    return [...items].sort(() => Math.random() - 0.5);
}
