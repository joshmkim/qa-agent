# Test environment: nike-storefront beta

What the QA fleet explores. Set up 2026-09-13.

| | |
|---|---|
| Repository | `TrentK014/nike-storefront` (fork of `joshmkim/nike-storefront`), stages `beta -> main` |
| URL | https://nike-storefront-git-beta-trent-kobieluszs-projects.vercel.app (Vercel branch alias; always the latest `beta` deploy) |
| Hosting | Vercel project `trent-kobieluszs-projects/nike-storefront`, git-connected; preview deployment protection is **off** so agents can reach it |
| Database | Supabase project `nike-storefront` (`zhwvnmsrtckennjphywu`), used only by this environment |
| Test shoppers | `qa-shopper-01..10@example.com`; credentials in `~/.config/qa-agent/nike-storefront-beta-shoppers.json` (never committed). Stage `credentialsRef`: `file://~/.config/qa-agent/nike-storefront-beta-shoppers.json` |
| Code primitives | `.qa/manifest.yaml` in the storefront repo |

Agents get all of this from `GET /api/runs/:id/context` (`environment.baseUrl`,
`environment.credentialsRef`, `environment.blastRadiusBoundaries`).

## What's in the storefront repo

- `supabase/migrations/`: schema for the 8 tables the app uses, reconstructed
  from its queries (the original project had no migrations), with row level
  security matching how API routes call Supabase with the shopper's JWT.
- `supabase/seed.sql`: 8 shoes; 116 size/color stock rows with sold-out (size
  12) and last-unit (size 8.5) variants and sale variants; discount codes
  `WELCOME10`, `SAVE20` (fixed, $100 minimum), `LIMITED1` (single use),
  `EXPIRED15`, `SOON25` (not yet valid). Shoe ids are fixed
  (`00000000-0000-4000-8000-00000000000N`).
- `scripts/qa/create-test-shoppers.mjs`: the app has no sign-up page, so
  shoppers are created with the admin API. Re-running resets passwords.
- `src/types/supabase.ts`: generated types. The app did not compile before
  (`next build` failed on stale hand-written types); it had only run under
  `next dev`.

## Operating it

- Reload schema + seed on a fresh project: `npx supabase link --project-ref <ref>`
  then `npx supabase db push --include-seed` (needs the database password).
- Reset data between fleet runs: re-run `supabase/seed.sql` after truncating
  `order_items, orders, cart_items, user_favorites, reviews, stock, discount_codes, shoes`
  (not yet scripted).
- Category pages (`/men`, `/sale`, ...) are statically rendered at build time,
  so catalog or stock changes only show after a redeploy (push to `beta`).
  Product behavior, not an environment bug; agents may report it.

## Verified end to end (2026-09-13)

Signed in as `qa-shopper-01`, added 2 x Pegasus Trail 5 (size 9) to the bag
(reservation 0 -> 2), checked out with `LIMITED1` (50% off, order and items
created, stock 10 -> 8, reservation released, bag cleared, `used_count` 1/1,
code then reported "no longer available"), purchase listed on the profile.
Category pages list the seeded shoes (men 3, women 3, kids 2, sale 3,
classics 4, sport 4).

## Open

- `credentialsRef` is not resolved yet (see `agent-next-steps.md`), so agents
  hit the login wall. A resolver for `file://` refs can read the shoppers file
  above and hand one account per agent.

- Per-agent isolation: 10 shared shopper accounts for now. Parallel agents
  share the catalog, stock and discount codes, so runs can interfere; decide
  between a reset per run and per-agent sandboxes before large fleets.
- Credentials live in a local file; move to a secrets manager when the
  orchestrator runs anywhere but a dev machine.
- The Supabase project is temporary; rotate the database password or delete
  the project when done.
