/**
 * Fetches Google Reviews and writes them into the website data JSON files.
 * Place IDs are read from websites.json (`business.googlePlacesId`; legacy: `reviews.googlePlacesId` on any page).
 *
 * Client resolution:
 *   1. `--client-id=<id>` on the command line — always uses that client (no prompt).
 *   2. Interactive terminal (TTY): enquirer prompt — ignores `CLIENT_ID` in .env so dev work
 *      for one site does not silently fetch reviews for another client.
 *   3. Non-interactive (CI, pipes): `CLIENT_ID` from the environment (e.g. .env.local).
 *      If missing, the script exits with an error.
 *
 * Usage:
 *   pnpm run 07-fetch-google-reviews
 *   pnpm run 07-fetch-google-reviews -- --client-id=haus-zum-wald
 *   pnpm run 07-fetch-google-reviews -- --website-id=bad-woerishofen-hotel-de
 *   pnpm run 07-fetch-google-reviews -- --site-id=bad-woerishofen-hotel-de   (alias of --website-id)
 *   pnpm run 07-fetch-google-reviews -- --client-id=haus-zum-wald --site-id=bad-woerishofen-hotel-de
 *
 * When `--website-id` or `--site-id` is set, only that entry is fetched (no other locations).
 * `scripts/clone-website.ts` passes `--site-id=<new-id>` automatically after a successful clone.
 *
 * Requires GOOGLE_PLACES_API_KEY in .env.local
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import * as dotenv from 'dotenv';
import { ApifyClient } from 'apify-client';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const DATA_ROOT = path.join(process.cwd(), 'src', 'data');
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const USE_APIFY = Boolean(APIFY_API_TOKEN);
const APIFY_ACTOR_ID = 'compass/google-maps-reviews-scraper';
const APIFY_BATCH_SIZES = [10, 30, 50];
const FIELD_MASK =
  'displayName,formattedAddress,addressComponents,location,regularOpeningHours,reviews,rating,userRatingCount';

const DAY_ABBR = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;

/**
 * Converts Google Places API `regularOpeningHours.periods` to compact German
 * strings like "Mo-Fr 09:00-17:00". Consecutive days with identical hours are
 * merged into ranges.
 */
function formatOpeningHours(
  periods: {
    open: { day: number; hour?: number; minute?: number };
    close?: { day?: number; hour?: number; minute?: number };
  }[]
): string[] {
  if (!periods.length) return [];

  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

  // Build per-day time strings (day 0=So, 1=Mo, ..., 6=Sa)
  const dayTimes = new Map<number, string>();
  for (const p of periods) {
    if (!p?.open || typeof p.open.day !== 'number') continue;
    const o = p.open;
    const c = p.close;
    const openH = o.hour ?? 0;
    const openM = o.minute ?? 0;
    // Places API omits `close` for 24/7 or open-ended periods; treat as end-of-day 24:00
    const closeH = c != null ? (c.hour ?? 0) : 24;
    const closeM = c != null ? (c.minute ?? 0) : 0;
    dayTimes.set(o.day, `${fmt(openH, openM)}-${fmt(closeH, closeM)}`);
  }

  // Walk Mo(1) → Sa(6), So(0) and merge consecutive days with same hours
  const order = [1, 2, 3, 4, 5, 6, 0];
  const result: string[] = [];
  let rangeStart: number | null = null;
  let rangePrev: number | null = null;
  let rangeTime: string | null = null;

  for (const day of order) {
    const time = dayTimes.get(day);
    if (time && time === rangeTime && rangePrev !== null) {
      rangePrev = day;
    } else {
      // Flush previous range
      if (rangeStart !== null && rangeTime) {
        const label =
          rangeStart === rangePrev
            ? DAY_ABBR[rangeStart!]
            : `${DAY_ABBR[rangeStart!]}-${DAY_ABBR[rangePrev!]}`;
        result.push(`${label} ${rangeTime}`);
      }
      if (time) {
        rangeStart = day;
        rangePrev = day;
        rangeTime = time;
      } else {
        rangeStart = null;
        rangePrev = null;
        rangeTime = null;
      }
    }
  }
  // Flush last range
  if (rangeStart !== null && rangeTime) {
    const label =
      rangeStart === rangePrev
        ? DAY_ABBR[rangeStart!]
        : `${DAY_ABBR[rangeStart!]}-${DAY_ABBR[rangePrev!]}`;
    result.push(`${label} ${rangeTime}`);
  }

  return result;
}

interface PageWithReviews {
  id?: string;
  name?: string;
  reviews?: {
    title?: string;
    subtitle?: string;
    reviewData?: unknown;
    googlePlacesId?: string;
  };
  [key: string]: unknown;
}

interface WebsiteWithPages {
  id?: string;
  business?: { googlePlacesId?: string };
  pages?: PageWithReviews[];
  [key: string]: unknown;
}

function getPlaceIdForWebsite(website: WebsiteWithPages): string | undefined {
  const fromBusiness = website.business?.googlePlacesId?.trim();
  if (fromBusiness) return fromBusiness;
  for (const page of website.pages ?? []) {
    const legacy = page.reviews?.googlePlacesId?.trim();
    if (legacy) return legacy;
  }
  return undefined;
}

function getAvailableClients(): string[] {
  if (!fs.existsSync(DATA_ROOT)) return [];
  return fs.readdirSync(DATA_ROOT).filter((f) => {
    const p = path.join(DATA_ROOT, f);
    return fs.statSync(p).isDirectory() && f !== 'current';
  });
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptClientId(): Promise<string> {
  const clients = getAvailableClients();
  if (clients.length === 0) {
    console.error('No client folders found in src/data/');
    process.exit(1);
  }
  try {
    const { default: enquirer } = await import('enquirer');
    const { clientId } = await enquirer.prompt<{ clientId: string }>({
      type: 'select',
      name: 'clientId',
      message: 'Which client should Google reviews be fetched for?',
      choices: clients,
    });
    return clientId;
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (
      e?.name === 'ExitPromptError' ||
      e?.message?.includes('User force closed')
    ) {
      process.exit(0);
    }
    throw err;
  }
}

/**
 * Returns one entry per website that has a googlePlacesId on `business` (or legacy `reviews`).
 */
function parseWebsitesArrayFromFile(sourcePath: string): WebsiteWithPages[] {
  const raw = fs.readFileSync(sourcePath, 'utf-8');
  const data = JSON.parse(raw) as
    | WebsiteWithPages[]
    | { shared?: unknown; websites: WebsiteWithPages[] };
  return Array.isArray(data) ? data : (data.websites ?? []);
}

function getWebsitesWithPlaceIds(
  sourcePath: string
): { websiteId: string; placeId: string }[] {
  const websites = parseWebsitesArrayFromFile(sourcePath);
  const out: { websiteId: string; placeId: string }[] = [];
  for (const website of websites) {
    if (!website.id) continue;
    const placeId = getPlaceIdForWebsite(website);
    if (placeId) {
      out.push({
        websiteId: website.id,
        placeId,
      });
    }
  }
  return out;
}

/**
 * Resolve exactly one site for review fetch when `--website-id` / `--site-id` is passed.
 * Avoids scanning every location and yields clearer errors than filtering the global list.
 */
function getFetchTargetForSingleSiteId(
  websitesJsonPath: string,
  siteId: string
): { websiteId: string; placeId: string } | { error: string } {
  const websites = parseWebsitesArrayFromFile(websitesJsonPath);
  const website = websites.find((w) => w.id === siteId);
  if (!website) {
    return {
      error: `No website with id "${siteId}" in ${path.relative(process.cwd(), websitesJsonPath)}.`,
    };
  }
  const placeId = getPlaceIdForWebsite(website);
  if (!placeId) {
    return {
      error:
        `Website "${siteId}" has no business.googlePlacesId (and no legacy pages[].reviews.googlePlacesId). ` +
        `Add the Google Place ID under "business", then run again. ` +
        `https://developers.google.com/maps/documentation/places/web-service/place-id`,
    };
  }
  return { websiteId: siteId, placeId };
}

function getWebsiteDataFiles(dataDir: string): string[] {
  if (!fs.existsSync(dataDir)) return [];
  const files = fs.readdirSync(dataDir);
  const websiteFiles = files.filter(
    (f) =>
      f === 'websites.json' ||
      (f.startsWith('websites-') && f.endsWith('.json'))
  );
  return websiteFiles.map((f) => path.join(dataDir, f));
}

async function fetchPlaceData(placeId: string): Promise<{
  displayName?: { text: string; languageCode: string };
  formattedAddress?: string;
  addressComponents?: { longText?: string; types?: string[] }[];
  location?: { latitude: number; longitude: number };
  regularOpeningHours?: {
    periods?: {
      open: { day: number; hour: number; minute: number };
      close: { day: number; hour: number; minute: number };
    }[];
  };
  reviews?: unknown[];
  rating?: number;
  userRatingCount?: number;
} | null> {
  if (!GOOGLE_PLACES_API_KEY) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set in .env.local');
  }

  const url = `https://places.googleapis.com/v1/places/${placeId}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
      Referer: 'https://hero-pages.com',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Places API ${res.status}: ${text}`);
  }

  return (await res.json()) as {
    displayName?: { text: string; languageCode: string };
    formattedAddress?: string;
    addressComponents?: { longText?: string; types?: string[] }[];
    location?: { latitude: number; longitude: number };
    regularOpeningHours?: {
      periods?: {
        open: { day: number; hour: number; minute: number };
        close: { day: number; hour: number; minute: number };
      }[];
    };
    reviews?: unknown[];
    rating?: number;
    userRatingCount?: number;
  };
}

function writeWebsiteDataFile(
  filePath: string,
  websites: WebsiteWithPages[]
): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const current = JSON.parse(raw) as
    | WebsiteWithPages[]
    | { shared?: unknown; websites: WebsiteWithPages[] };
  const payload = Array.isArray(current) ? websites : { ...current, websites };
  // Preserve canonical Schema.org `@type`/`@id` keys verbatim. (A previous
  // regex here wrapped them as `[@type]`/`[@id]` and broke JSON-LD parsers.)
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function parseWebsiteDataFile(filePath: string): WebsiteWithPages[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw) as
    | WebsiteWithPages[]
    | { shared?: unknown; websites: WebsiteWithPages[] };
  if (Array.isArray(data)) return data as WebsiteWithPages[];
  if (
    data &&
    Array.isArray((data as { websites?: WebsiteWithPages[] }).websites)
  )
    return (data as { websites: WebsiteWithPages[] }).websites;
  return [];
}

function websiteMatchesPlaceId(
  website: WebsiteWithPages,
  placeId: string
): boolean {
  const b = website.business?.googlePlacesId?.trim();
  if (b === placeId) return true;
  return (website.pages ?? []).some(
    (p) => p.reviews?.googlePlacesId === placeId
  );
}

// ---------------------------------------------------------------------------
// Apify integration — smart hybrid review fetching
// ---------------------------------------------------------------------------

interface ApifyReview {
  reviewId?: string;
  name?: string;
  text?: string;
  textTranslated?: string | null;
  stars?: number;
  publishAt?: string;
  publishedAtDate?: string;
  reviewUrl?: string;
  reviewerUrl?: string;
  reviewerPhotoUrl?: string;
  originalLanguage?: string;
  [key: string]: unknown;
}

function normalizeApifyReview(r: ApifyReview): {
  name: string;
  relativePublishTimeDescription: string;
  rating: number;
  text: { text: string; languageCode: string };
  originalText: { text: string; languageCode: string };
  authorAttribution: { displayName: string; uri: string; photoUri?: string };
  publishTime: string;
  googleMapsUri: string;
} {
  const lang = (r.originalLanguage as string) ?? 'de';
  return {
    name: (r.reviewId as string) ?? '',
    relativePublishTimeDescription: (r.publishAt as string) ?? '',
    rating: (r.stars as number) ?? 0,
    text: {
      text: (r.textTranslated as string) ?? (r.text as string) ?? '',
      languageCode: lang,
    },
    originalText: {
      text: (r.text as string) ?? '',
      languageCode: lang,
    },
    authorAttribution: {
      displayName: (r.name as string) ?? 'Anonymous',
      uri: (r.reviewerUrl as string) ?? '',
      ...(r.reviewerPhotoUrl ? { photoUri: r.reviewerPhotoUrl as string } : {}),
    },
    publishTime: (r.publishedAtDate as string) ?? '',
    googleMapsUri: (r.reviewUrl as string) ?? '',
  };
}

/**
 * Smart hybrid review fetching via Apify.
 * Sorts by highest ranking (5-star first), progressively widens batch size
 * until enough reviews meeting minRating are found or no more are available.
 */
async function fetchReviewsViaApify(
  placeId: string,
  minRating: number,
  targetCount: number,
  verbose: boolean = false
): Promise<ReturnType<typeof normalizeApifyReview>[]> {
  const client = new ApifyClient({ token: APIFY_API_TOKEN });
  const placeUrl = `https://www.google.com/maps/place/?q=place_id:${placeId}`;

  for (const batchSize of APIFY_BATCH_SIZES) {
    if (verbose)
      console.log(
        `  [Apify] Fetching ${batchSize} reviews (sorted by highestRanking)...`
      );

    const run = await client.actor(APIFY_ACTOR_ID).call(
      {
        startUrls: [{ url: placeUrl }],
        maxReviews: batchSize,
        reviewsSort: 'highestRanking',
        language: 'de',
      },
      { waitSecs: 120 }
    );

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    const reviews = (items as ApifyReview[]).map(normalizeApifyReview);
    const filtered = reviews.filter((r) => r.rating >= minRating);

    if (verbose)
      console.log(
        `  [Apify] Got ${reviews.length} reviews, ${filtered.length} with ${minRating}+ stars`
      );

    // Enough reviews found
    if (filtered.length >= targetCount) {
      return filtered;
    }

    // No more reviews available (got fewer than requested)
    if (reviews.length < batchSize) {
      return filtered;
    }
  }

  // Exhausted all batch sizes — return whatever we have
  return [];
}

function applyReviewDataToWebsite(
  website: WebsiteWithPages,
  placeId: string,
  reviewData: Record<string, unknown>
): void {
  if (!website.business) website.business = {};
  website.business.googlePlacesId = placeId;

  const home =
    website.pages?.find((p) => p.name === 'home') ?? website.pages?.[0];
  if (!home) return;
  if (!home.reviews) home.reviews = {};
  home.reviews.reviewData = reviewData;
  if (home.reviews.googlePlacesId != null) {
    delete home.reviews.googlePlacesId;
  }
}

async function run(): Promise<void> {
  const clientIdArg = process.argv.find((a) => a.startsWith('--client-id='));
  const cliClientId =
    clientIdArg?.replace('--client-id=', '').trim() || undefined;
  const envClientId = process.env.CLIENT_ID?.trim() || undefined;
  const verbose =
    process.argv.includes('--verbose') || process.argv.includes('-v');

  // Prefer explicit CLI, then CLIENT_ID (e.g. from `pnpm master`), then interactive prompt.
  let clientId: string;
  if (cliClientId) {
    clientId = cliClientId;
  } else if (envClientId) {
    clientId = envClientId;
  } else if (isInteractiveTerminal()) {
    clientId = await promptClientId();
  } else {
    console.error(
      'Non-interactive run: set CLIENT_ID in the environment or pass --client-id=<id>'
    );
    process.exit(1);
  }

  // Ensure websites.json is up-to-date before fetching reviews.
  console.log('Step 1/2 — Preparing website data...\n');
  const excelScript = path.resolve(
    process.cwd(),
    'scripts',
    '04-process-excel-data.mjs'
  );
  const excelResult = spawnSync(
    process.execPath,
    [excelScript, `--client=${clientId}`],
    {
      stdio: 'inherit',
      cwd: process.cwd(),
    }
  );
  if (excelResult.status !== 0) {
    console.error(
      '\nFailed to prepare website data — aborting Google reviews fetch.'
    );
    process.exit(excelResult.status ?? 1);
  }
  console.log('\nStep 2/2 — Fetching Google reviews…\n');

  const dataDir = path.join(DATA_ROOT, clientId);
  const websitesJsonPath = path.join(dataDir, 'websites.json');

  const websiteIdArg = process.argv.find((a) => a.startsWith('--website-id='));
  const siteIdArg = process.argv.find((a) => a.startsWith('--site-id='));
  const filterWebsiteId = (
    siteIdArg?.replace('--site-id=', '').trim() ||
    websiteIdArg?.replace('--website-id=', '').trim() ||
    ''
  ).trim();

  if (!fs.existsSync(websitesJsonPath)) {
    console.error(`websites.json not found: ${websitesJsonPath}`);
    console.error(
      'Pick a client that has websites.json, or pass --client-id=<id> (non-interactive: set CLIENT_ID).'
    );
    process.exit(1);
  }

  let toFetch: { websiteId: string; placeId: string }[];

  if (filterWebsiteId) {
    console.log(
      `Single-site mode: only "${filterWebsiteId}" will be fetched.\n`
    );
    const one = getFetchTargetForSingleSiteId(
      websitesJsonPath,
      filterWebsiteId
    );
    if ('error' in one) {
      console.error(one.error);
      process.exit(1);
    }
    toFetch = [one];
  } else {
    toFetch = getWebsitesWithPlaceIds(websitesJsonPath);
    if (toFetch.length === 0) {
      console.error(
        `No website in ${path.relative(process.cwd(), websitesJsonPath)} has a non-empty business.googlePlacesId\n` +
          `(or legacy pages[].reviews.googlePlacesId). Add the Google Place ID under each website’s "business" object,\n` +
          'then run this script again. How to find a Place ID: https://developers.google.com/maps/documentation/places/web-service/place-id'
      );
      process.exit(1);
    }
  }

  console.log(`Review source: ${USE_APIFY ? 'Apify' : 'Google Places API'}`);

  if (verbose) {
    console.log('Google Reviews → JSON data files\n');
    console.log(`Client:  ${clientId}`);
    console.log(`Source:  ${websitesJsonPath}`);
    if (filterWebsiteId) {
      console.log('Filter:  website', filterWebsiteId);
    } else {
      console.log('Websites to update:', toFetch.length);
    }
    console.log('');
  }
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error('GOOGLE_PLACES_API_KEY is not set in .env.local');
    process.exit(1);
  }

  const files = getWebsiteDataFiles(dataDir);
  if (files.length === 0) {
    console.error(`No websites.json or websites-*.json found in ${dataDir}`);
    process.exit(1);
  }

  for (const { websiteId, placeId } of toFetch) {
    console.log(`\n${websiteId}`);
    if (verbose) console.log('  Place ID:', placeId);

    const minRating = 5;
    const targetReviewCount = 6;

    // Always fetch business metadata from Google Places API (address, hours, geo, rating)
    const placeData = await fetchPlaceData(placeId);
    if (!placeData) {
      console.log('  ⚠ Skipped (no data from API)');
      continue;
    }

    // Fetch reviews: Apify (smart hybrid) or Google Places API (fallback)
    let filteredReviews: unknown[];
    if (USE_APIFY) {
      try {
        const apifyReviews = await fetchReviewsViaApify(
          placeId,
          minRating,
          targetReviewCount,
          verbose
        );
        filteredReviews = apifyReviews;
        console.log(
          `  ${placeData.displayName?.text ?? 'N/A'} | ${filteredReviews.length} reviews (${minRating}★) via Apify | ${placeData.userRatingCount ?? 0} total ratings`
        );
      } catch (err) {
        console.warn(
          `  ⚠ Apify failed, falling back to Google Places: ${(err as Error).message}`
        );
        const allReviews = (placeData.reviews ?? []) as { rating?: number }[];
        filteredReviews = allReviews.filter(
          (r) => typeof r.rating === 'number' && r.rating >= minRating
        );
        console.log(
          `  ${placeData.displayName?.text ?? 'N/A'} | ${filteredReviews.length} reviews (${minRating}★) via Google Places | ${placeData.userRatingCount ?? 0} total ratings`
        );
      }
    } else {
      const allReviews = (placeData.reviews ?? []) as { rating?: number }[];
      filteredReviews = allReviews.filter(
        (r) => typeof r.rating === 'number' && r.rating >= minRating
      );
      console.log(
        `  ${placeData.displayName?.text ?? 'N/A'} | ${filteredReviews.length} reviews (${minRating}★) via Google Places | ${placeData.userRatingCount ?? 0} total ratings`
      );
    }

    const reviewData = {
      displayName: placeData.displayName ?? { text: '', languageCode: 'de' },
      formattedAddress: placeData.formattedAddress ?? '',
      reviews: filteredReviews,
      userRatingCount: placeData.userRatingCount ?? 0,
      rating: placeData.rating,
    };

    // Extract city and neighborhood from Google Places address data
    const addressParts = (placeData.formattedAddress ?? '')
      .split(',')
      .map((s) => s.trim());
    const placeCity =
      addressParts.length >= 3
        ? addressParts[addressParts.length - 2].replace(/^\d{4,6}\s+/, '')
        : undefined;
    const placeNeighborhood = placeData.addressComponents
      ?.find(
        (c) =>
          c.types?.includes('neighborhood') || c.types?.includes('sublocality')
      )
      ?.longText?.trim();

    const placeLat = placeData.location?.latitude;
    const placeLng = placeData.location?.longitude;

    for (const filePath of files) {
      const websites = parseWebsiteDataFile(filePath);
      let changed = false;
      for (const website of websites) {
        if (website.id !== websiteId) continue;
        if (!websiteMatchesPlaceId(website, placeId)) continue;
        applyReviewDataToWebsite(website, placeId, reviewData);

        // Populate business.location fields from Google Places if empty
        if (website.business) {
          const loc = (website.business as Record<string, unknown>).location as
            | { city?: string; district?: string; neighborhood?: string }
            | undefined;
          if (loc) {
            if (placeCity && !loc.city) {
              loc.city = placeCity;
              console.log(`  Set business.location.city → "${placeCity}"`);
            }
            if (
              placeNeighborhood &&
              (!loc.neighborhood || loc.neighborhood === loc.city)
            ) {
              loc.neighborhood = placeNeighborhood;
              console.log(
                `  Set business.location.neighborhood → "${placeNeighborhood}"`
              );
            }
          }
        }

        // Populate geo metadata from Google Places coordinates if available
        if (
          placeLat != null &&
          placeLng != null &&
          Array.isArray(website.pages)
        ) {
          const home = website.pages[0] as Record<string, unknown> | undefined;
          const geo = (home?.metadata as Record<string, unknown> | undefined)
            ?.geo as Record<string, string> | undefined;
          if (geo) {
            const latStr = String(placeLat);
            const lngStr = String(placeLng);
            if (!geo.icbm) geo.icbm = `${latStr}, ${lngStr}`;
            if (!geo.position) geo.position = `${latStr};${lngStr}`;
          }
          // Schema localBusiness geo
          const schemas = (
            home?.metadata as Record<string, unknown> | undefined
          )?.schema as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(schemas)) {
            for (const schema of schemas) {
              const schemaData = schema.data as
                | Record<string, unknown>
                | undefined;
              const schemaGeo = schemaData?.geo as
                | Record<string, string>
                | undefined;
              if (schemaGeo) {
                if (!schemaGeo.latitude) schemaGeo.latitude = String(placeLat);
                if (!schemaGeo.longitude)
                  schemaGeo.longitude = String(placeLng);
              }
            }
          }
          if (geo || schemas) {
            console.log(`  Set geo coordinates → ${placeLat}, ${placeLng}`);
          }
        }

        // Populate schema openingHoursSpecification from Google Places
        const openingPeriods = placeData.regularOpeningHours?.periods;
        if (
          Array.isArray(openingPeriods) &&
          openingPeriods.length > 0 &&
          Array.isArray(website.pages)
        ) {
          const home = website.pages[0] as Record<string, unknown> | undefined;
          const schemas = (
            home?.metadata as Record<string, unknown> | undefined
          )?.schema as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(schemas)) {
            const hours = formatOpeningHours(openingPeriods);
            if (hours.length > 0) {
              for (const schema of schemas) {
                const data = schema.data as Record<string, unknown> | undefined;
                if (!data) continue;
                const spec = data.openingHoursSpecification;
                if (Array.isArray(spec) && spec.length === 0) {
                  data.openingHoursSpecification = hours;
                }
              }
              console.log(
                `  Set openingHoursSpecification → ${JSON.stringify(hours)}`
              );
            }
          }

          // Populate business.openingHours.short and .detailed from Google Places
          const hours = formatOpeningHours(openingPeriods);
          if (hours.length > 0 && website.business) {
            const biz = website.business as Record<string, unknown>;
            const oh = (biz.openingHours ?? {}) as Record<string, string>;

            // Build short display: "Täglich HH:MM – HH:MM Uhr" if all days same, otherwise join ranges
            const allSameTime =
              hours.length === 1 && hours[0].startsWith('Mo-So');
            const timeOnly = hours[0]
              .replace(/^[A-Za-z-]+\s+/, '')
              .replace('-', ' – ');
            const shortText = allSameTime
              ? `Täglich ${timeOnly} Uhr`
              : hours.join(', ');

            // Build detailed display: full day ranges on separate lines
            const DAY_FULL: Record<string, string> = {
              Mo: 'Montag',
              Di: 'Dienstag',
              Mi: 'Mittwoch',
              Do: 'Donnerstag',
              Fr: 'Freitag',
              Sa: 'Samstag',
              So: 'Sonntag',
            };
            const detailedLines = hours.map((h) => {
              const [dayPart, ...timeParts] = h.split(' ');
              const time = timeParts.join(' ').replace('-', ' – ');
              const expanded = dayPart.replace(
                /([A-Za-z]{2})/g,
                (m) => DAY_FULL[m] ?? m
              );
              return `${expanded}: ${time} Uhr`;
            });
            const detailedText = detailedLines.join('\n');

            if (!oh.short) {
              oh.short = shortText;
              console.log(`  Set openingHours.short → "${shortText}"`);
            }
            if (!oh.detailed) {
              oh.detailed = detailedText;
            }
            biz.openingHours = oh;
          }
        }

        changed = true;
      }
      if (changed) {
        writeWebsiteDataFile(filePath, websites);
        console.log('  Updated', path.basename(filePath));
      }
    }
  }

  console.log('\nDone.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
