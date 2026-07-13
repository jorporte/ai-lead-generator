export function isDryRun() {
    return ['1', 'true', 'yes', 'on'].includes((process.env.DRY_RUN || '').toLowerCase());
}

export function describeRunMode() {
    return isDryRun() ? 'DRY RUN' : 'LIVE';
}
