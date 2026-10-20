import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createEstimate, type QuoteRequest, type QuotePolicy, type QuoteProduct, type CompetitorOffer } from '../src/quotes/engine';
import { QuoteStore, customerQuote } from '../src/quotes/store';

/** Owner's local CLI, not a customer API. Do not expose this shell through the web. */
async function main() {
    const [command, argument, overrideFile] = process.argv.slice(2);
    const store = new QuoteStore(path.resolve(process.env.QUOTE_DATA_DIR || 'data/quotes'));
    if (command === 'create' && argument) {
        const input = JSON.parse(await readFile(argument, 'utf8')) as {
            request: QuoteRequest; product: QuoteProduct; offers: CompetitorOffer[]; policy: QuotePolicy;
        };
        if (!Array.isArray(input.offers)) throw new Error('Expected an offers array');
        const record = await store.create(createEstimate(input.request, input.product, input.offers, input.policy));
        console.log(JSON.stringify(customerQuote(record), null, 2));
    } else if (command === 'show' && argument) {
        console.log(JSON.stringify(customerQuote(await store.read(argument)), null, 2));
    } else if (command === 'history' && argument) {
        console.log(JSON.stringify((await store.history(argument)).map(r => customerQuote(r)), null, 2));
    } else if (command === 'revise' && argument && overrideFile) {
        const override = JSON.parse(await readFile(overrideFile, 'utf8')) as { tireUnitCents: number; reason: string };
        const record = await store.revise(argument, override.tireUnitCents, override.reason);
        console.log(JSON.stringify(customerQuote(record), null, 2));
    } else {
        throw new Error('Usage: npm run quotes -- create INPUT.json | show ID | history ID | revise ID OVERRIDE.json');
    }
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
