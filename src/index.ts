// src/index.ts
import 'dotenv/config'; // <--- MUST BE AT THE ABSOLUTE TOP
import { runScraper } from './scraper';
import { describeRunMode } from './config';

async function main() {
    console.log(`🚀 Launching Rebel Wheels Deal Hunter (${describeRunMode()} mode)...`);
    await runScraper();
}

main().catch((err) => {
    console.error('💥 Critical Orchestration Failure:', err);
});
