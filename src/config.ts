export function isDryRun() {
    return ['1', 'true', 'yes', 'on'].includes((process.env.DRY_RUN || '').toLowerCase());
}

export function isDevMode() {
    return ['1', 'true', 'yes', 'on'].includes((process.env.DEV_MODE || '').toLowerCase());
}

export function isBrowserHeadless() {
    const value = (process.env.BROWSER_HEADLESS || '').toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return true;
}

export function describeRunMode() {
    return isDryRun() ? 'DRY RUN' : 'LIVE';
}
