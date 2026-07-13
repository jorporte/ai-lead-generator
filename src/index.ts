// src/index.ts
import 'dotenv/config'; // <--- MUST BE AT THE ABSOLUTE TOP
import { runScraper } from './scraper';

async function main() {
    console.log('🚀 Launching Rebel Wheels Deal Hunter...');
    await runScraper();
}

main().catch((err) => {
    console.error('💥 Critical Orchestration Failure:', err);
});