/**
 * Fixtures modelled on the live QA target, TrentK014/nike-storefront (beta
 * branch deployed to Vercel). Repository, branches, PRs, SHAs and the manifest
 * mirror the real repo as of 2026-09-13; run and finding data are fixtures for
 * UI iteration when no control plane is configured.
 */
import type {
  ManifestSnapshot,
  Pipeline,
  Repository,
  Stage,
  PullRequestRef,
  Surface,
  Invariant,
} from "@qa-agent/shared-types";

export const BETA_URL = "https://nike-storefront-git-beta-trent-kobieluszs-projects.vercel.app";

export const repository: Repository = {
  id: "repo_nike_storefront",
  owner: "TrentK014",
  name: "nike-storefront",
  fullName: "TrentK014/nike-storefront",
  defaultBranch: "main",
  installationId: 91027446,
  url: "https://github.com/TrentK014/nike-storefront",
};

/** Real commits on origin/beta and origin/main. */
export const SHA = {
  main: "3b61a4b6a1cfe6929dde9e9a33a6c6151186bd01",
  beta_pr3_merge: "d051d3a16221d4710949a324ad77faa7a484dd89", // #3 add manifest
  beta_pr4_merge: "59bff418f11fd997910450e58385ddbbf2ad006e", // #4 sale-sticker test id
  beta_pr7_merge: "ae26a64047fa6698c3c398b66b143fd74cf254ac", // #7 page scroll
};

export const stages: Stage[] = [
  {
    id: "stage_beta",
    repositoryId: repository.id,
    name: "beta",
    branch: "beta",
    order: 1,
    environmentUrl: BETA_URL,
    budgetSeconds: 240,
    cursor: {
      sha: SHA.beta_pr7_merge,
      prNumber: 7,
      updatedAt: "2026-09-13T20:56:31Z",
    },
    gatesPromotion: true,
    protectedBranch: "main",
    fleetSize: 10,
    latestRunId: "run_beta_2",
  },
  {
    id: "stage_prod",
    repositoryId: repository.id,
    name: "prod",
    branch: "main",
    order: 2,
    cursor: {
      sha: SHA.main,
      updatedAt: "2026-09-13T18:41:02Z",
    },
    gatesPromotion: false,
    fleetSize: 10,
  },
];

export const pipeline: Pipeline = {
  id: "pl_nike_storefront",
  repository,
  name: "nike-storefront",
  stages,
  manifestPath: ".qa/manifest.yaml",
  manifestVersion: "1",
  createdAt: "2026-09-13T18:41:02Z",
};

const prUrl = (n: number) => `${repository.url}/pull/${n}`;

/** PRs merged to beta between the #4 merge (cursor) and the #7 merge (head). */
export const betaPullRequests: PullRequestRef[] = [
  {
    number: 7,
    title: "fix(layout): Restore mouse wheel and trackpad scrolling",
    body: "`overflow: hidden` on `html, body` in globals.css blocked wheel and trackpad scrolling on every page. Scope it to the hero only.",
    author: "TrentK014",
    labels: [],
    linkedIssues: [],
    url: prUrl(7),
    mergedAt: "2026-09-13T20:56:24Z",
    filesChanged: 1,
    additions: 4,
    deletions: 1,
  },
  {
    number: 6,
    title: "fix(types): Generate Supabase database types so the app builds",
    body: "Replaces the hand-written `src/types/database.ts` with generated `src/types/supabase.ts` from the beta project schema.",
    author: "TrentK014",
    labels: [],
    linkedIssues: [],
    url: prUrl(6),
    mergedAt: "2026-09-13T20:42:46Z",
    filesChanged: 2,
    additions: 459,
    deletions: 167,
  },
  {
    number: 5,
    title: "chore(qa): Add beta environment schema, seed, and test shopper script",
    body: "Reconstruct the Supabase schema from the app's queries (8 tables with row level security), seed a catalog with sold-out sizes, last-unit sizes, sale variants, and discount codes covering single-use, expired and future codes, and add a script that creates test shopper accounts through the admin API.",
    author: "TrentK014",
    labels: [],
    linkedIssues: [],
    url: prUrl(5),
    mergedAt: "2026-09-13T20:39:14Z",
    filesChanged: 5,
    additions: 233,
    deletions: 0,
  },
];

/** The single PR in run #1's window (#3 merge -> #4 merge). */
export const betaPullRequestsRun1: PullRequestRef[] = [
  {
    number: 4,
    title: "feat(sale-sticker): Add test id to discount sticker",
    body: "Adds `data-testid=\"sale-sticker\"` to `SaleSticker` so the QA fleet can locate discount stickers on cards and the size selector.",
    author: "TrentK014",
    labels: [],
    linkedIssues: [],
    url: prUrl(4),
    mergedAt: "2026-09-13T19:46:40Z",
    filesChanged: 1,
    additions: 1,
    deletions: 0,
  },
];

const GRID_SOURCES = [
  "src/lib/category-shoes.ts",
  "src/components/ProductGridWithFavorites.tsx",
  "src/components/ProductCard.tsx",
  "src/components/SaleSticker.tsx",
];

/** The 26 surfaces from .qa/manifest.yaml. `touchedByChange` reflects run #2 (#7 touched globals.css). */
export const surfaces: Surface[] = [
  {
    id: "layout-nav",
    kind: "flow",
    name: "Storefront layout and nav bar",
    locator: "nav",
    description: "Top navigation, bag count badge, product grid with favorite hearts.",
    sources: ["src/components/StorefrontLayout.tsx", "src/components/NavBar.tsx", "src/app/layout.tsx", "src/app/globals.css"],
    touchedByChange: true,
  },
  { id: "home", kind: "page", name: "Home", locator: "/", sources: ["src/app/page.tsx"] },
  { id: "category-men", kind: "page", name: "Men", locator: "/men", sources: ["src/app/men/**", ...GRID_SOURCES] },
  { id: "category-women", kind: "page", name: "Women", locator: "/women", sources: ["src/app/women/**", ...GRID_SOURCES] },
  { id: "category-kids", kind: "page", name: "Kids", locator: "/kids", sources: ["src/app/kids/**", ...GRID_SOURCES] },
  { id: "category-sport", kind: "page", name: "Sport", locator: "/sport", sources: ["src/app/sport/**", ...GRID_SOURCES] },
  { id: "category-classics", kind: "page", name: "Classics", locator: "/classics", sources: ["src/app/classics/**", ...GRID_SOURCES] },
  {
    id: "sale",
    kind: "page",
    name: "Sale",
    locator: "/sale",
    description: "Only shoes with a stock row that has sale_percent > 0.",
    sources: ["src/app/sale/**", ...GRID_SOURCES],
  },
  {
    id: "shoe-detail",
    kind: "page",
    name: "Shoe detail",
    locator: "/shoe/:id",
    description: "Size selector (per-size sale stickers), add to bag modal, review feed.",
    sources: [
      "src/app/shoe/**",
      "src/components/ShoeDetailContent.tsx",
      "src/components/ShoeSizeSelector.tsx",
      "src/components/SaleSticker.tsx",
      "src/components/AddedToBagModal.tsx",
    ],
  },
  { id: "size-selector", kind: "form", name: "Size selector", locator: "[data-size]", sources: ["src/components/ShoeSizeSelector.tsx", "src/components/SaleSticker.tsx"] },
  {
    id: "add-to-bag",
    kind: "button",
    name: "Add to bag",
    locator: "button:has-text('Add to Bag')",
    sources: ["src/components/ShoeDetailContent.tsx", "src/components/AddedToBagModal.tsx", "src/app/api/cart/route.ts"],
  },
  { id: "favorite-heart", kind: "button", name: "Favorite heart", locator: "[aria-label*='avorite']", sources: ["src/components/FavoriteHeart.tsx", "src/app/api/favorites/**"] },
  {
    id: "review-feed",
    kind: "form",
    name: "Reviews on shoe detail",
    locator: "/shoe/:id",
    sources: ["src/components/ReviewFeed.tsx", "src/app/api/reviews/**", "src/app/api/shoes/*/reviews/**"],
  },
  { id: "cart", kind: "page", name: "Bag", locator: "/cart", sources: ["src/app/cart/**", "src/app/api/cart/**"] },
  {
    id: "checkout",
    kind: "flow",
    name: "Checkout",
    locator: "/checkout",
    description: "Bag summary, discount code, place order.",
    sources: ["src/app/checkout/**", "src/app/api/checkout/**", "src/app/api/discount/**"],
  },
  { id: "favorites", kind: "page", name: "Favorites", locator: "/favorites", sources: ["src/app/favorites/**", "src/components/FavoriteHeart.tsx"] },
  { id: "login", kind: "form", name: "Login / sign up", locator: "/login", sources: ["src/app/login/**", "src/lib/supabase.ts"] },
  {
    id: "profile",
    kind: "page",
    name: "Profile and purchases",
    locator: "/profile",
    description: "Purchased shoes and the review form for them.",
    sources: ["src/app/profile/**", "src/app/api/profile/**"],
  },
  { id: "api-cart", kind: "endpoint", name: "GET/POST /api/cart", locator: "/api/cart", sources: ["src/app/api/cart/route.ts"] },
  { id: "api-cart-item", kind: "endpoint", name: "DELETE /api/cart/[id]", locator: "/api/cart/:id", sources: ["src/app/api/cart/[id]/**"] },
  { id: "api-checkout", kind: "endpoint", name: "POST /api/checkout", locator: "/api/checkout", sources: ["src/app/api/checkout/**"] },
  { id: "api-discount-validate", kind: "endpoint", name: "POST /api/discount/validate", locator: "/api/discount/validate", sources: ["src/app/api/discount/**"] },
  { id: "api-favorites-toggle", kind: "endpoint", name: "POST /api/favorites/toggle", locator: "/api/favorites/toggle", sources: ["src/app/api/favorites/**"] },
  { id: "api-purchases", kind: "endpoint", name: "GET /api/profile/purchases", locator: "/api/profile/purchases", sources: ["src/app/api/profile/**"] },
  {
    id: "api-reviews",
    kind: "endpoint",
    name: "POST /api/reviews and GET /api/shoes/[id]/reviews",
    locator: "/api/reviews",
    sources: ["src/app/api/reviews/**", "src/app/api/shoes/*/reviews/**"],
  },
  { id: "api-stock", kind: "endpoint", name: "GET /api/shoes/[id]/stock", locator: "/api/shoes/:id/stock", sources: ["src/app/api/shoes/*/stock/**"] },
];

/** The 10 invariants from .qa/manifest.yaml. */
export const invariants: Invariant[] = [
  {
    id: "discount-counted-on-order",
    statement: "A discount code's used_count increases only when an order is actually created with that code, and never beyond max_uses.",
    severityOnViolation: "P0",
    surfaceIds: ["checkout", "api-checkout", "api-discount-validate"],
  },
  {
    id: "order-total-matches-bag",
    statement:
      "An order's total equals the sum of unit price x quantity, where unit price is msrp x (1 - sale_percent/100) for that size and color, minus the applied discount, and is never below zero.",
    check: "order.total == max(0, sum(item.msrp * (1 - item.sale_percent / 100) * item.quantity) - discount)",
    severityOnViolation: "P0",
    surfaceIds: ["checkout", "cart", "api-checkout"],
  },
  {
    id: "checkout-success-means-order",
    statement: "Checkout reports success only if an order with all bag items was created; stock is deducted and the bag is cleared only in that case.",
    severityOnViolation: "P0",
    surfaceIds: ["checkout", "api-checkout"],
  },
  {
    id: "no-overselling",
    statement: "Stock quantity never goes below zero and an order never includes more units of a size and color than were available when it was placed.",
    severityOnViolation: "P0",
    surfaceIds: ["add-to-bag", "checkout", "api-cart", "api-checkout", "api-stock"],
  },
  {
    id: "own-data-only",
    statement: "A shopper can only read or change their own bag items, favorites, orders and reviews; requests for another user's records fail.",
    severityOnViolation: "P0",
    surfaceIds: ["cart", "favorites", "profile", "api-cart", "api-cart-item", "api-favorites-toggle", "api-purchases", "api-reviews"],
  },
  {
    id: "reserved-stock-released",
    statement: "Removing an item from the bag releases exactly the stock it had reserved.",
    severityOnViolation: "P1",
    surfaceIds: ["cart", "api-cart-item", "api-stock"],
  },
  {
    id: "sale-price-parity",
    statement: "The sale sticker and price shown for a size on the product card and shoe page match the unit price charged in the bag and at checkout.",
    severityOnViolation: "P1",
    surfaceIds: ["sale", "shoe-detail", "size-selector", "cart", "checkout"],
  },
  {
    id: "reviews-require-purchase",
    statement: "A shopper can review a shoe only after purchasing it, at most once per shoe, with a rating from 1 to 5.",
    severityOnViolation: "P1",
    surfaceIds: ["review-feed", "profile", "api-reviews", "api-purchases"],
  },
  {
    id: "bag-count-matches-bag",
    statement: "The bag count in the nav bar equals the total quantity of items on the bag page.",
    severityOnViolation: "P2",
    surfaceIds: ["layout-nav", "cart"],
  },
  {
    id: "favorite-toggle-roundtrip",
    statement: "Toggling a favorite twice returns the shoe to its original favorited state everywhere it is shown.",
    severityOnViolation: "P2",
    surfaceIds: ["favorite-heart", "favorites", "api-favorites-toggle"],
  },
];

/** The manifest the fixture runs used, as the control plane would serve it. */
export const manifestSnapshot: ManifestSnapshot = {
  path: pipeline.manifestPath,
  commitSha: SHA.beta_pr7_merge,
  status: "loaded",
  loadedAt: "2026-09-13T20:56:32Z",
  product: {
    productName: "Nike Storefront",
    intent:
      "Shoppers browse shoes by category (men, women, kids, sport, classics, sale), open a shoe to pick a size, favorite shoes, add sized items to their bag, and check out with an optional discount code. Signed-in shoppers can review shoes they have purchased. Sale prices come from each stock row's sale_percent.",
    stakeholders: ["storefront team"],
    surfaces,
    invariants,
    manifestVersion: pipeline.manifestVersion,
    boundaries: [
      "Use only the storefront's pages and its /api routes; never call Supabase directly with the anon key.",
      "Never create, edit or delete shoes, stock rows or discount codes except through shopper actions in the app.",
      "Only sign in as the provided test accounts; do not sign up new real-looking accounts with real email addresses.",
      "Do not use real payment details or real personal data.",
    ],
  },
};
