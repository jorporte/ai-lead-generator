#!/bin/bash

# Navigate into your local workspace directory
cd /Users/jordan/Documents/RWT/RebelDealHunter

# Load your system's default environment profile path strings
source ~/.bash_profile 2>/dev/null
source ~/.zshrc 2>/dev/null

# Force run your local project using the exact path mapping of npx/node
/usr/local/bin/npx tsx src/index.ts >> logs/cron_output.log 2>&1
