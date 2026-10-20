# Quote engine: first implementation

Tracking: [project board](https://github.com/users/jorporte/projects/1) and
[roadmap #10](https://github.com/jorporte/ai-lead-generator/issues/10).

This first increment implements the calculation and private saved-quote foundation
for #2 and #5. It is an owner's local CLI, not a public website or customer agent.
The scraper, cron schedule and social publishing path do not call it and remain
separate. It does not research live competitor prices, reserve stock, send messages,
place orders or charge customers.

## Pricing behavior

- All money is integer Canadian cents. Tax and margins use basis points: 100 basis
  points is one percentage point. All policy fields must be explicitly supplied;
  missing charges are not treated as zero.
- Set the two minimum-margin fields to Jordan's approved commercial rules in a
  private input file. These are **tire selling-price margins**, not markups.
  The minimum unit price is rounded upwards from `landed cost / (1 - margin)`.
- Landed tire cost includes supplier price, freight and other tire acquisition
  costs. Mounting is a separate service charge; its revenue is not used to pretend
  the tires have a higher margin. This module does not yet calculate service profit.
- Verified complete installed/tax-in competitors take precedence for a mounted
  quote. Otherwise compare advertised per-tire prices and display the full Rebel
  package separately. Tires-only quotes never compare to installed packages.
- The configured undercut is a policy choice, not a hard-coded discount. If the
  cheapest comparable offer cannot be beaten at the floor, return `needs_review`
  without an automatic price. No evidence means review, not a fixed cost-plus quote.
- Exact product/specification identity, region and CAD currency are required.
  Verification must include eligibility, membership/rebate conditions, delivery
  charges, fees, studding, load/speed and construction. The module cannot verify
  those facts itself. Customer-supplied evidence must never set `comparisonVerified`.
- Future-dated, stale, unavailable and incompatible evidence is excluded. Quote
  validity ends at the earliest of configured duration and evidence expiration.
- `supplier_local` is supplier inventory, not Rebel-owned stock. No inventory is
  reserved. Vehicle fitment is not inferred from tire size.

## Owner CLI

Keep inputs in ignored `data/` or outside the repository. The engine requires a
trusted JSON document with `request`, `product`, `offers` and `policy` keys, matching
the exported interfaces in `src/quotes/engine.ts`. There are no production policy
defaults. Confirm tax, recycling fees/treatment, mounting charges, service area,
comparison freshness and competitive advantage before using real quotes.

```bash
npm run quotes -- create data/quote-input.json
npm run quotes -- show RWT-YYYYMMDD-0123456789ABCDEF
npm run quotes -- history RWT-YYYYMMDD-0123456789ABCDEF
```

`tests/quotes.test.ts` contains complete **synthetic** inputs for developers. Do not
use those test values as live prices, tax advice or real availability.

The CLI outputs only the customer-safe projection; internal costs, margins,
comparison verification keys and owner reasons stay in the private saved record.
Stock location and estimate validity remain visible. Expired quotes suppress prices.

## Friends/family adjustments

On the owner's server, create an ignored override file:

```json
{
  "tireUnitCents": 12345,
  "reason": "Owner-approved custom pricing"
}
```

The number above is illustrative, not a proposed customer price. Apply explicitly:

```bash
npm run quotes -- revise ORIGINAL_QUOTE_ID data/quote-override.json
```

Only the owner CLI can do this in this release. A customer's claimed relationship
does not trigger this path. Owner revisions intentionally permit a tire price below
the automatic floor, recalculate the full invoice, require a reason and preserve the
original. Each revision gets a new quote ID with `parentId` and `rootId` links.
Pass the latest revision ID to `history` to traverse its ancestry. Revisions form
immutable branches; they do not silently replace the original. Refresh expired
evidence or resolve inventory/size problems before revising.

## Storage and next steps

Records default to `data/quotes/`; `QUOTE_DATA_DIR` can select a private directory.
New directories use mode 0700 and records 0600. Complete files are published through
an exclusive hard link after writing/flushing a temporary file on the same volume.
No existing record is overwritten; multiple processes can create distinct IDs.
Keep this directory on a local persistent Linux filesystem, outside the web root,
and include it in private backups. Existing directories must have their permissions
checked separately. A failed read is an error, never a reason to discard records.

The next increments add supplier snapshots (#3), verified research/imports (#4),
authenticated owner access and the public estimate/request flow (#6), and hosting
(#7). Do not expose raw record files or this local CLI as an unauthenticated API.
Neither quote IDs nor access to a public Project board are authentication.

## Validation

```bash
npm run check
npm test
```

CI installs fresh dependencies and runs both checks. Tests exercise margin floors,
rounding, installed/per-tire comparison rules, evidence freshness, inventory,
private/customer separation and immutable revisions. Live supplier/competitor
connections are not used by these tests.
