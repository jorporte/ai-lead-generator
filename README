Markdown
# 🛞 Rebel Wheels Daily Deal Hunter & Social Marketer

[cite_start]An autonomous wholesale arbitrage engine designed to monitor distributor pipelines, isolate premium clearance pricing trends, and distribute promotional flyer creatives natively to customer-facing channels[cite: 3, 409, 588].

---

## 🏗️ Architecture Blueprint
[cite_start]The ecosystem operates as a zero-overhead local daemon composed of three distinct execution phases[cite: 39, 40, 454]:

1. [cite_start]**The Core Scraper (`src/scraper.ts`):** Operates headlessly using Playwright[cite: 731]. [cite_start]It bypasses expensive UI click hoops by leveraging session persistence, checking active sale inventories across Passenger, Light Truck (LT), and 35" flotation matrices, and filtering strictly for actionable sets of 4+ tires[cite: 43, 200, 705, 807].
2. [cite_start]**The High-Res Interceptor:** Isolates the single highest discount deal of the sweep[cite: 748, 807]. [cite_start]It programmatically interrogates the storefront’s hidden asynchronous background XHR fragment endpoints (`data-ajaxurl`), matches target media sizing signatures (`600-conversionFormat`), and extracts the master high-fidelity product graphic while ignoring random brand logos[cite: 782, 794, 807].
3. [cite_start]**The Marketing Module (`src/instagram.ts`):** Downloads the raw asset, dynamically scales it into a premium square dark slate canvas utilizing the `sharp` graphics engine, overlays vector pricing layers (enforcing a strict $75 minimum retail threshold), streams the output to a Supabase bucket, and schedules live delivery to Meta feeds on autopilot[cite: 634, 680, 710, 808].

---

## 📦 Project Directory Tree
```text
RebelDealHunter/
├── auth/
│   └── state.json           # Cached enterprise portal security session states
├── data/
│   └── raw_inventory.json   # Processed local catalog datasets segmented by size
├── src/
│   ├── index.ts             # Primary orchestrator and entry hook
│   ├── scraper.ts           # Playwright dealer portal navigation and DOM engine
│   ├── notifier.ts          # Telegram digest assembly and text broadcaster
│   └── instagram.ts         # Sharp graphic generator and Meta publisher
├── .env                     # Private application credentials and API keys
├── package.json             # Node.js dependencies and run-scripts
└── README.md                # System documentation
🛠️ Environmental Key Properties (.env)
Ensure your local project root contains a secure .env file populated with the following configuration lines:

Code snippet
# --- DT Tire Dealer Hub Access ---
DT_TIRE_USER="your_dealer_username"
DT_TIRE_PASS="your_secure_password"

# --- Telegram Messenger Bot API ---
TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
TELEGRAM_CHAT_ID="-100XXXXXXXXXX"

# --- Supabase Bucket Storage Bridge ---
SUPABASE_URL="[https://your-project-id.supabase.co](https://your-project-id.supabase.co)"
SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsIn..."

# --- Meta Integration Core Access ---
INSTAGRAM_ACCOUNT_ID="your_instagram_business_numeric_id"
INSTAGRAM_ACCESS_TOKEN="EAAM..."
🚀 Transferring & Initializing on a New Desktop
Desktops are optimized to run 24/7. To migrate the code from your MacBook Pro to a dedicated desktop machine, execute these initialization steps:

1. Extract the Project Footprint

Zip up the project folder, making sure to exclude the local node_modules folder to prevent cross-compilation OS corruption. Extract the zip archive on your target desktop.

2. Install Clean Dependencies
Open your terminal application inside the extracted folder root and run:

Bash
# Pull down production dependencies (sharp, playwright, supabase, axios, etc)
npm install

# Download clean browser binaries targeted explicitly to this machine's architecture
npx playwright install
⏰ Configuration of the 24/7 Automation Scheduler
To configure the system to hunt for clearance item drops precisely at 8:00 AM and 4:00 PM daily, bind the execution layer to your machine's respective operating system daemon:

🍏 Option A: Migrating to a Mac Desktop (iMac, Mac mini, Mac Studio)
Copy the background profile script template to the global daemon agents folder:

Bash
cp com.rebelwheels.dealhunter.plist ~/Library/LaunchAgents/
Open that .plist file and update the WorkingDirectory and StandardOutPath absolute path variables (e.g., /Users/jordan/...) to mirror your new desktop's actual user layout.

Register the scheduling block directly into the macOS kernel engine:

Bash
launchctl load ~/Library/LaunchAgents/com.rebelwheels.dealhunter.plist
🪟 Option B: Migrating to a Windows PC Desktop
Create a plain Windows batch file named run_windows.bat in your project root directory:

Code snippet
@echo off
cd /d "C:\Absolute\Path\To\Your\Extracted\RebelDealHunter"
npx tsx src/index.ts >> data/cron_output.log 2>&1
Open the Windows Start Menu, search for Task Scheduler, and click Create Basic Task.

Name it Rebel Tire Hunter, map the trigger parameter to Daily, and specify a start floor time of 8:00 AM.

Set the Action type parameter to Start a program and browse to select your run_windows.bat file.

Go to the task's Properties, open the Triggers tab, add a second independent trigger configuration rule, and map it to execute at 4:00 PM.

In the General tab of the properties window, check the box for "Run whether user is logged on or not" so the tool queries the portal even when the system workstation sits locked.

💤 Critical Desktop Sleep Guard
Desktops will turn off background scripts if they drop into sleep mode. Ensure your desktop hardware configurations are optimized:


On macOS: Open System Settings -> Energy Saver and enable "Prevent computer from sleeping automatically when the display is off".


On Windows: Open Settings -> Power & Sleep and switch the computer sleep configuration timers explicitly to "Never".

Rebel Wheels and Tires © 2026 — Built Lean, Operating Efficiently.


***

Once this `README.md` file is saved inside your workspace folder, compress your root