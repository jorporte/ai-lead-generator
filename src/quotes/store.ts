import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { type Estimate, priceBreakdown, customerEstimate } from './engine';

export interface QuoteRecord {
    schemaVersion: 1;
    id: string;
    rootId: string;
    parentId: string | null;
    kind: 'automatic' | 'owner_revision';
    ownerReason: string | null;
    estimate: Estimate;
}

/** Private, local-only storage. A future web layer must authenticate owner access. */
export class QuoteStore {
    constructor(private readonly directory: string) {}

    private file(id: string): string {
        if (!/^RWT-\d{8}-[0-9A-F]{16}$/.test(id)) throw new Error('Invalid quote ID');
        return path.join(this.directory, `${id}.json`);
    }

    private async append(estimate: Estimate, parent: QuoteRecord | null, reason: string | null): Promise<QuoteRecord> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const stamp = estimate.createdAt.slice(0, 10).replace(/-/g, '');
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const id = `RWT-${stamp}-${randomBytes(8).toString('hex').toUpperCase()}`;
            const record: QuoteRecord = {
                schemaVersion: 1, id, rootId: parent?.rootId ?? id, parentId: parent?.id ?? null,
                kind: parent ? 'owner_revision' : 'automatic', ownerReason: reason,
                estimate: structuredClone(estimate),
            };
            const temporary = path.join(this.directory, `.${id}-${randomBytes(8).toString('hex')}.tmp`);
            try {
                await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600, flush: true });
                // Link publishes the complete record atomically and refuses to overwrite a quote.
                await link(temporary, this.file(id));
                return record;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
                throw error;
            } finally {
                await unlink(temporary).catch(() => undefined);
            }
        }
        throw new Error('Unable to allocate quote ID');
    }

    async create(estimate: Estimate): Promise<QuoteRecord> {
        return this.append(estimate, null, null);
    }

    async read(id: string): Promise<QuoteRecord> {
        const record = JSON.parse(await readFile(this.file(id), 'utf8')) as QuoteRecord;
        if (record.schemaVersion !== 1 || record.id !== id) throw new Error('Invalid quote record');
        return record;
    }

    async history(id: string): Promise<QuoteRecord[]> {
        const records: QuoteRecord[] = [];
        const seen = new Set<string>();
        let current: string | null = id;
        while (current) {
            if (seen.has(current) || records.length >= 1000) throw new Error('Invalid quote history');
            seen.add(current);
            const record = await this.read(current);
            records.push(record);
            current = record.parentId;
        }
        return records.reverse();
    }

    /** Called only by the owner CLI. Bypasses automatic margin floors intentionally. */
    async revise(id: string, tireUnitCents: number, reason: string, now = new Date()): Promise<QuoteRecord> {
        if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw new Error('An owner revision requires a reason');
        const parent = await this.read(id);
        if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(parent.estimate.createdAt)
            || now.getTime() >= Date.parse(parent.estimate.expiresAt)) throw new Error('Refresh expired quote evidence before revising');
        if (parent.estimate.reason === 'size_mismatch' || parent.estimate.reason === 'inventory_unavailable') {
            throw new Error('Resolve inventory/size issues before revising');
        }
        const estimate = structuredClone(parent.estimate);
        estimate.createdAt = now.toISOString();
        estimate.price = priceBreakdown(tireUnitCents, estimate.request, estimate.policy);
        estimate.status = 'estimated';
        estimate.reason = 'owner_priced';
        return this.append(estimate, parent, reason.trim());
    }
}

export function customerQuote(record: QuoteRecord, now = new Date()) {
    return { id: record.id, rootId: record.rootId, parentId: record.parentId,
        kind: record.kind, estimate: customerEstimate(record.estimate, now) };
}
