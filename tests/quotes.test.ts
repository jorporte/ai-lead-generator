import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEstimate, customerEstimate, minimumUnitPrice, priceBreakdown, normalizeSize,
    type QuotePolicy, type QuoteRequest, type QuoteProduct, type CompetitorOffer } from '../src/quotes/engine';
import { QuoteStore, customerQuote } from '../src/quotes/store';

// All prices, fees and rates here are synthetic test inputs, not live quotes or configured business policy.
const now = new Date('2026-01-02T12:00:00Z');
const request: QuoteRequest = { size: '225/65R17', quantity: 4, withMounting: false, region: 'CA-NL' };
const policy: QuotePolicy = {
    tireOnlyMinimumMarginBps: 500, mountedMinimumMarginBps: 100, taxBps: 1500,
    recyclingFeeCentsPerTire: 400, recyclingFeeTaxable: true,
    mountingCentsPerTire: 3000, mountingTaxable: true, undercutCentsPerTire: 100,
    inventoryMaxAgeHours: 24, competitorMaxAgeHours: 48, validityHours: 24,
};
const product: QuoteProduct = {
    id: 'test-tire', brand: 'Example', model: 'Winter', size: '225/65R17',
    specificationKey: 'example-winter-225/65R17-102H-XL-nonstudded',
    landedCostCentsPerTire: 10000, availableQuantity: 8, stockLocation: 'supplier_local',
    verifiedAt: '2026-01-02T11:00:00Z',
};
const offer: CompetitorOffer = {
    id: 'offer-1', competitor: 'Example competitor', sourceUrl: 'https://example.com/tire',
    specificationKey: product.specificationKey, currency: 'CAD', region: 'CA-NL',
    basis: 'per_tire_before_tax', amountCents: 15000, quantity: 1,
    verifiedAt: '2026-01-02T10:00:00Z', available: true, comparisonVerified: true,
};
const estimate = (r = request, p = product, offers = [offer], rules = policy) => createEstimate(r, p, offers, rules, now);

test('margin floor rounds upwards and is a margin rather than a markup', () => {
    assert.equal(minimumUnitPrice(10000, 100), 10102);
    assert.equal(minimumUnitPrice(10000, 500), 10527);
    for (const cost of [1, 17, 1000, 10001, 99999999]) {
        for (const margin of [1, 100, 500, 3300, 9999]) {
            const floor = minimumUnitPrice(cost, margin);
            assert.ok(BigInt(floor - cost) * 10000n >= BigInt(floor) * BigInt(margin));
            assert.ok(BigInt(floor - 1 - cost) * 10000n < BigInt(floor - 1) * BigInt(margin));
        }
    }
});
test('prices against per-tire competition, keeping services and fees separate', () => {
    const result = estimate();
    assert.equal(result.status, 'estimated');
    assert.deepEqual(result.price, { tireUnitCents: 14900, tiresCents: 59600,
        mountingCents: 0, recyclingCents: 1600, taxCents: 9180, totalCents: 70380 });
    assert.equal(result.comparison?.basis, 'per_tire_before_tax');
});
test('mounting selection changes the tire floor and adds the configured service price once', () => {
    const bare = estimate(request, product, [{ ...offer, amountCents: 10500 }]);
    const mounted = estimate({ ...request, withMounting: true }, product, [{ ...offer, amountCents: 10500 }]);
    assert.equal(bare.reason, 'below_floor');
    assert.equal(bare.price, null);
    assert.equal(mounted.status, 'estimated');
    assert.equal(mounted.price?.mountingCents, 12000);
    assert.equal(mounted.floorUnitCents, 10102);
});
test('verified installed totals take precedence and invert rounded tax exactly', () => {
    const r = { ...request, withMounting: true };
    const result = estimate(r, product, [offer, { ...offer, id: 'package', basis: 'installed_total_tax_in', quantity: 4, amountCents: 80000 }]);
    assert.equal(result.comparison?.id, 'package');
    assert.ok(result.price);
    assert.ok(result.price.totalCents <= 79600);
    assert.ok(priceBreakdown(result.price.tireUnitCents + 1, r, policy).totalCents > 79600);
});
test('tires-only quotes do not compare against an installed package', () => {
    assert.equal(estimate(request, product, [{ ...offer, basis: 'installed_total_tax_in', quantity: 4 }]).reason, 'no_verified_competitor');
});
test('the cheapest comparable verified offer is selected regardless of input ordering', () => {
    const result = estimate(request, product, [offer, { ...offer, id: 'cheaper', amountCents: 14000 }]);
    assert.equal(result.comparison?.id, 'cheaper');
    assert.equal(result.price?.tireUnitCents, 13900);
});
test('below-floor competition does not trigger automatic undercutting', () => {
    assert.equal(estimate(request, product, [{ ...offer, amountCents: 10000 }]).reason, 'below_floor');
});
test('missing comparison evidence yields review, not a cost-plus fallback', () => {
    assert.equal(estimate(request, product, []).price, null);
    assert.equal(estimate(request, product, []).reason, 'no_verified_competitor');
});
for (const [label, patch] of Object.entries({
    'different specifications': { specificationKey: 'other-load-rating' },
    'different region': { region: 'CA-ON' },
    'unverified offer': { comparisonVerified: false },
    'truthy unverified flag': { comparisonVerified: 'yes' },
    'unavailable offer': { available: false },
    'future timestamp': { verifiedAt: '2026-01-03T00:00:00Z' },
    'old evidence': { verifiedAt: '2025-12-30T00:00:00Z' },
    'malformed date': { verifiedAt: 'unknown' },
    'wrong currency': { currency: 'USD' },
    'unsupported quantity': { quantity: 8 },
    'negative price': { amountCents: -5 },
    'fractional cents': { amountCents: 15000.5 },
    'missing source': { sourceUrl: '' },
    'credential in URL': { sourceUrl: 'https://password@example.com/tire' },
})) {
    test(`rejects ${label} as competitor evidence`, () => {
        assert.equal(estimate(request, product, [{ ...offer, ...patch } as CompetitorOffer]).reason, 'no_verified_competitor');
    });
}
test('stale, future and insufficient inventory do not produce a price', () => {
    for (const p of [{ ...product, availableQuantity: 3 }, { ...product, verifiedAt: '2025-12-31T00:00:00Z' },
        { ...product, verifiedAt: '2026-01-03T00:00:00Z' }]) {
        assert.equal(estimate(request, p).reason, 'inventory_unavailable');
    }
});
test('exact tire-size match is required and LT is not silently substituted', () => {
    assert.equal(normalizeSize('lt 265/70r17'), 'LT265/70R17');
    assert.equal(estimate({ ...request, size: 'LT225/65R17' }).reason, 'size_mismatch');
    assert.throws(() => normalizeSize('whatever'));
});
test('quote validity never outlives inventory or competitor evidence', () => {
    const result = estimate(request, product, [{ ...offer, verifiedAt: '2025-12-31T13:00:00Z' }]);
    assert.equal(result.expiresAt, '2026-01-02T13:00:00.000Z');
    assert.equal(customerEstimate(result, new Date('2026-01-02T13:00:00Z')).price, null);
    assert.equal(customerEstimate(result, new Date('2026-01-02T13:00:00Z')).status, 'expired');
});
test('taxability configuration controls the taxable base', () => {
    const result = priceBreakdown(10000, { ...request, withMounting: true },
        { ...policy, recyclingFeeTaxable: false, mountingTaxable: false });
    assert.equal(result.taxCents, 6000);
    assert.equal(result.totalCents, 59600);
});
test('missing or invalid charges, costs and mounting inputs are not silently defaulted', () => {
    assert.throws(() => estimate(request, product, [offer], { ...policy, taxBps: undefined } as unknown as QuotePolicy));
    assert.throws(() => estimate({ ...request, withMounting: 'false' } as unknown as QuoteRequest));
    assert.throws(() => estimate({ ...request, quantity: 0 }));
    assert.throws(() => estimate(request, { ...product, landedCostCentsPerTire: 0 }));
    assert.throws(() => minimumUnitPrice(1, 10000));
});
test('customer projection excludes cost, margin policies and internal review reasons', () => {
    const result = customerEstimate(estimate(), now);
    const json = JSON.stringify(result);
    for (const secret of ['landedCost', 'floorUnit', 'MinimumMargin', 'policy', 'specificationKey']) assert.ok(!json.includes(secret));
});
test('quotes persist with private permissions, immutable revisions and public-safe output', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rwt-quotes-'));
    try {
        const store = new QuoteStore(directory);
        const original = await store.create(estimate());
        const before = JSON.stringify(await store.read(original.id));
        const revision = await store.revise(original.id, 10000, 'Owner-authorized custom price', now);
        assert.notEqual(revision.id, original.id);
        assert.equal(revision.rootId, original.id);
        assert.equal(revision.parentId, original.id);
        assert.equal(revision.estimate.reason, 'owner_priced');
        assert.equal(JSON.stringify(await store.read(original.id)), before);
        assert.equal((await store.history(revision.id)).length, 2);
        assert.equal((await stat(path.join(directory, `${original.id}.json`))).mode & 0o777, 0o600);
        assert.ok(!JSON.stringify(customerQuote(revision, now)).includes('Owner-authorized'));
        assert.ok(!JSON.stringify(customerQuote(revision, now)).includes('landedCost'));
        await assert.rejects(store.revise(original.id, 1, '', now));
        await assert.rejects(store.revise(original.id, 1, 'Late adjustment', new Date('2027-01-01')));
        await assert.rejects(store.read('../../.env'));
        assert.equal((await readdir(directory)).filter(f => f.endsWith('.tmp')).length, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
test('concurrent writes get unique IDs without losing records', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rwt-quotes-'));
    try {
        const store = new QuoteStore(directory);
        const records = await Promise.all(Array.from({ length: 12 }, () => store.create(estimate())));
        assert.equal(new Set(records.map(r => r.id)).size, 12);
        assert.equal((await readdir(directory)).length, 12);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
