// scripts/refresh-token.ts
import 'dotenv/config';
import { automateTokenExchange } from '../src/instagram';

async function run() {
    // Grab the token string passed via the terminal command arguments
    const shortLivedToken = process.argv[2];

    if (!shortLivedToken) {
        console.error('\n❌ Error: You must provide the short-lived access token from the Meta Graph Explorer.');
        console.error('📋 Usage: npx tsx scripts/refresh-token.ts "YOUR_SHORT_LIVED_TOKEN_HERE"\n');
        process.exit(1);
    }

    console.log('🔄 Initiating automated token exchange pipeline...');
    await automateTokenExchange(shortLivedToken);
}

run().catch((err) => {
    console.error('💥 Script Execution Failure:', err);
});