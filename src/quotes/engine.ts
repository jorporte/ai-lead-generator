/** Pure quote calculations. Inputs must come from trusted server-side sources. */
export interface QuoteRequest {
    size: string;
    quantity: number;
    withMounting: boolean;
    region: string;
}

export interface QuotePolicy {
    tireOnlyMinimumMarginBps: number;
    mountedMinimumMarginBps: number;
    taxBps: number;
    recyclingFeeCentsPerTire: number;
    recyclingFeeTaxable: boolean;
    mountingCentsPerTire: number;
    mountingTaxable: boolean;
    undercutCentsPerTire: number;
    inventoryMaxAgeHours: number;
    competitorMaxAgeHours: number;
    validityHours: number;
}

export interface QuoteProduct {
    id: string;
    brand: string;
    model: string;
    size: string;
    /** Owner-verified identity including size, load/speed, construction and studding. */
    specificationKey: string;
    landedCostCentsPerTire: number;
    availableQuantity: number;
    stockLocation: 'supplier_local' | 'supplier_other_warehouse' | 'rebel';
    verifiedAt: string;
}

export interface CompetitorOffer {
    id: string;
    competitor: string;
    sourceUrl: string;
    specificationKey: string;
    currency: 'CAD';
    region: string;
    basis: 'per_tire_before_tax' | 'installed_total_tax_in';
    amountCents: number;
    /** Exact package quantity, or minimum purchasable quantity for a per-tire offer. */
    quantity: number;
    verifiedAt: string;
    available: boolean;
    /** Owner/research verifier has checked eligibility, shipping, fees and specification match. */
    comparisonVerified: boolean;
}

export interface PriceBreakdown {
    tireUnitCents: number;
    tiresCents: number;
    mountingCents: number;
    recyclingCents: number;
    taxCents: number;
    totalCents: number;
}

export interface Estimate {
    status: 'estimated' | 'needs_review';
    reason: 'competitive' | 'owner_priced' | 'size_mismatch' | 'inventory_unavailable' | 'no_verified_competitor' | 'below_floor';
    request: QuoteRequest;
    product: QuoteProduct;
    policy: QuotePolicy;
    createdAt: string;
    expiresAt: string;
    floorUnitCents: number;
    comparison: CompetitorOffer | null;
    price: PriceBreakdown | null;
    notice: string;
}

const MAX_MONEY = 100_000_000;
function integer(value: unknown, name: string, min = 0, max = MAX_MONEY): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`Invalid ${name}`);
    }
}
function text(value: unknown, name: string): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error(`Invalid ${name}`);
}
function bool(value: unknown, name: string): asserts value is boolean {
    if (typeof value !== 'boolean') throw new Error(`Invalid ${name}`);
}
export function normalizeSize(value: string): string {
    text(value, 'tire size');
    const size = value.toUpperCase().replace(/\s/g, '');
    if (!/^(?:(?:LT|P)?\d{3}\/\d{2}R\d{2}|\d{2}(?:\.\d)?X\d{1,2}(?:\.\d{1,2})?R\d{2})$/.test(size)) {
        throw new Error('Use an exact tire size, for example 225/65R17');
    }
    return size;
}
export function validatePolicy(policy: QuotePolicy): void {
    integer(policy.tireOnlyMinimumMarginBps, 'tire-only margin', 1, 9999);
    integer(policy.mountedMinimumMarginBps, 'mounted margin', 1, 9999);
    integer(policy.taxBps, 'tax rate', 0, 10000);
    integer(policy.recyclingFeeCentsPerTire, 'recycling fee');
    integer(policy.mountingCentsPerTire, 'mounting charge');
    integer(policy.undercutCentsPerTire, 'competitive advantage', 1);
    integer(policy.inventoryMaxAgeHours, 'inventory freshness', 1, 720);
    integer(policy.competitorMaxAgeHours, 'competitor freshness', 1, 720);
    integer(policy.validityHours, 'quote validity', 1, 720);
    bool(policy.recyclingFeeTaxable, 'recycling tax treatment');
    bool(policy.mountingTaxable, 'mounting tax treatment');
}
export function minimumUnitPrice(costCents: number, marginBps: number): number {
    integer(costCents, 'landed cost', 1);
    integer(marginBps, 'minimum margin', 1, 9999);
    const numerator = BigInt(costCents) * 10000n;
    const divisor = BigInt(10000 - marginBps);
    return Number((numerator + divisor - 1n) / divisor);
}
export function priceBreakdown(unitCents: number, request: QuoteRequest, policy: QuotePolicy): PriceBreakdown {
    integer(unitCents, 'tire price', 1, MAX_MONEY * 10000);
    integer(request.quantity, 'quantity', 1, 8);
    bool(request.withMounting, 'mounting selection');
    validatePolicy(policy);
    const tiresCents = unitCents * request.quantity;
    const mountingCents = request.withMounting ? policy.mountingCentsPerTire * request.quantity : 0;
    const recyclingCents = policy.recyclingFeeCentsPerTire * request.quantity;
    const taxable = tiresCents + (policy.mountingTaxable ? mountingCents : 0)
        + (policy.recyclingFeeTaxable ? recyclingCents : 0);
    const taxCents = Number((BigInt(taxable) * BigInt(policy.taxBps) + 5000n) / 10000n);
    return { tireUnitCents: unitCents, tiresCents, mountingCents, recyclingCents, taxCents,
        totalCents: tiresCents + mountingCents + recyclingCents + taxCents };
}
function timestamp(value: string): number {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return NaN;
    return Date.parse(value);
}
function fresh(value: string, maxHours: number, now: number): boolean {
    const age = now - timestamp(value);
    return Number.isFinite(age) && age >= 0 && age < maxHours * 3600000;
}
function validateProduct(product: QuoteProduct): void {
    for (const key of ['id', 'brand', 'model', 'specificationKey'] as const) text(product[key], key);
    normalizeSize(product.size);
    integer(product.landedCostCentsPerTire, 'landed cost', 1);
    integer(product.availableQuantity, 'stock quantity', 0, 1_000_000);
    if (!['supplier_local', 'supplier_other_warehouse', 'rebel'].includes(product.stockLocation)) {
        throw new Error('Invalid stock location');
    }
}
function eligible(offer: CompetitorOffer, product: QuoteProduct, request: QuoteRequest,
    policy: QuotePolicy, now: number): boolean {
    if (!offer || offer.comparisonVerified !== true || offer.available !== true
        || offer.currency !== 'CAD' || offer.region !== request.region
        || offer.specificationKey !== product.specificationKey
        || !fresh(offer.verifiedAt, policy.competitorMaxAgeHours, now)) return false;
    if (!['per_tire_before_tax', 'installed_total_tax_in'].includes(offer.basis)) return false;
    if (!Number.isSafeInteger(offer.amountCents) || offer.amountCents <= 0 || offer.amountCents > MAX_MONEY) return false;
    if (!Number.isSafeInteger(offer.quantity) || offer.quantity < 1 || offer.quantity > 8) return false;
    if (offer.basis === 'installed_total_tax_in' ? offer.quantity !== request.quantity : offer.quantity > request.quantity) return false;
    try {
        text(offer.id, 'offer id'); text(offer.competitor, 'competitor');
        const url = new URL(offer.sourceUrl);
        if (url.protocol !== 'https:' || url.username || url.password) return false;
    } catch { return false; }
    return true;
}
/** No fallback cost-plus price: without verified competition, an owner reviews the quote. */
export function createEstimate(request: QuoteRequest, product: QuoteProduct, offers: CompetitorOffer[],
    policy: QuotePolicy, now = new Date()): Estimate {
    validatePolicy(policy); validateProduct(product);
    integer(request.quantity, 'quantity', 1, 8); bool(request.withMounting, 'mounting selection');
    text(request.region, 'region');
    const size = normalizeSize(request.size);
    const time = now.getTime();
    if (!Number.isFinite(time)) throw new Error('Invalid quote date');
    const normalized: QuoteRequest = { size, quantity: request.quantity,
        withMounting: request.withMounting, region: request.region };
    const floor = minimumUnitPrice(product.landedCostCentsPerTire,
        request.withMounting ? policy.mountedMinimumMarginBps : policy.tireOnlyMinimumMarginBps);
    const validUntil = Math.min(time + policy.validityHours * 3600000,
        timestamp(product.verifiedAt) + policy.inventoryMaxAgeHours * 3600000);
    const result: Estimate = {
        status: 'needs_review', reason: 'inventory_unavailable', request: normalized,
        product: structuredClone(product), policy: structuredClone(policy), createdAt: now.toISOString(),
        expiresAt: new Date(Number.isFinite(validUntil) ? Math.max(time, validUntil) : time).toISOString(),
        floorUnitCents: floor, comparison: null, price: null,
        notice: 'Estimate only. Availability and fitment require confirmation. No stock is reserved. Pickup pricing; delivery requires confirmation.',
    };
    if (size !== normalizeSize(product.size)) return { ...result, reason: 'size_mismatch' };
    if (product.availableQuantity < request.quantity || !fresh(product.verifiedAt, policy.inventoryMaxAgeHours, time)) return result;
    const verified = offers.filter(offer => eligible(offer, product, normalized, policy, time));
    const installed = request.withMounting ? verified.filter(o => o.basis === 'installed_total_tax_in') : [];
    // Complete installed comparisons take precedence; otherwise compare only advertised tire prices.
    const candidates = installed.length ? installed : verified.filter(o => o.basis === 'per_tire_before_tax');
    const comparison = [...candidates].sort((a, b) => a.amountCents - b.amountCents)[0];
    if (!comparison) return { ...result, reason: 'no_verified_competitor' };
    result.comparison = structuredClone(comparison);
    result.expiresAt = new Date(Math.min(validUntil,
        timestamp(comparison.verifiedAt) + policy.competitorMaxAgeHours * 3600000)).toISOString();
    let targetUnit: number;
    if (comparison.basis === 'per_tire_before_tax') {
        targetUnit = comparison.amountCents - policy.undercutCentsPerTire;
    } else {
        const targetTotal = comparison.amountCents - policy.undercutCentsPerTire * request.quantity;
        let low = 0;
        let high = comparison.amountCents;
        // Invert the actual rounded invoice calculation rather than approximating tax backwards.
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (priceBreakdown(mid, normalized, policy).totalCents <= targetTotal) low = mid;
            else high = mid - 1;
        }
        targetUnit = low;
    }
    if (targetUnit < floor) return { ...result, reason: 'below_floor' };
    return { ...result, status: 'estimated', reason: 'competitive', price: priceBreakdown(targetUnit, normalized, policy) };
}

/** Only this projection may be sent to a customer; the stored estimate contains private costs. */
export function customerEstimate(estimate: Estimate, now = new Date()) {
    const currentTime = now.getTime();
    const expiration = Date.parse(estimate.expiresAt);
    const expired = !Number.isFinite(currentTime) || !Number.isFinite(expiration) || currentTime >= expiration;
    const price = expired ? null : estimate.price;
    const comparison = estimate.comparison;
    return {
        status: expired ? 'expired' : estimate.status,
        request: estimate.request,
        product: { id: estimate.product.id, brand: estimate.product.brand, model: estimate.product.model,
            size: estimate.product.size, stockLocation: estimate.product.stockLocation },
        createdAt: estimate.createdAt, expiresAt: estimate.expiresAt, price,
        comparison: price && comparison ? { competitor: comparison.competitor, sourceUrl: comparison.sourceUrl,
            basis: comparison.basis, amountCents: comparison.amountCents, quantity: comparison.quantity,
            verifiedAt: comparison.verifiedAt } : null,
        notice: estimate.notice,
    };
}
