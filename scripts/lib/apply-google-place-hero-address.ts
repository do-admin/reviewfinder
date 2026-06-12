/**
 * Fetches `formattedAddress` (and `addressComponents`) from Google Places API (New)
 * and applies them to the home page hero address card (card2Line1 / card2Line2)
 * and optionally to `business.locationAddress` when it is still empty.
 *
 * Uses the same endpoint and env as `07-fetch-google-reviews.ts` (GOOGLE_PLACES_API_KEY).
 */

const PLACE_FIELD_MASK = 'formattedAddress,addressComponents';

/**
 * Splits a Places `formattedAddress` into two lines: street (first segment) and the rest
 * (postal code, city, region, country) — matches common hero card layout.
 */
export function splitFormattedAddressForHero(formattedAddress: string): {
  line1: string;
  line2: string;
} {
  const t = formattedAddress.trim();
  if (!t) return { line1: '', line2: '' };
  const parts = t
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { line1: '', line2: '' };
  if (parts.length === 1) return { line1: parts[0] ?? '', line2: '' };
  return { line1: parts[0] ?? '', line2: parts.slice(1).join(', ') };
}

function getAddressComponent(
  addressComponents: { longText?: string; types?: string[] }[] | undefined,
  ...types: string[]
): string {
  if (!addressComponents?.length) return '';
  for (const t of types) {
    const c = addressComponents.find((x) => x.types?.includes(t));
    const v = c?.longText?.trim();
    if (v) return v;
  }
  return '';
}

/**
 * Best-effort street / postal / city for `business.locationAddress` from Places components.
 */
export function addressComponentsToLocationAddress(
  addressComponents: { longText?: string; types?: string[] }[] | undefined
): { street: string; postalCode: string; city: string } | null {
  if (!addressComponents?.length) return null;
  const num = getAddressComponent(addressComponents, 'street_number');
  const route = getAddressComponent(addressComponents, 'route');
  const street = [route, num].filter(Boolean).join(' ').trim();
  const postalCode = getAddressComponent(addressComponents, 'postal_code');
  const city = getAddressComponent(
    addressComponents,
    'locality',
    'postal_town',
    'sublocality_level_1',
    'administrative_area_level_2'
  );
  if (!street && !postalCode && !city) return null;
  return { street, postalCode, city };
}

export type FetchPlaceAddressResult = {
  formattedAddress: string;
  addressComponents?: { longText?: string; types?: string[] }[];
};

/**
 * GET Place (New) — same pattern as `scripts/07-fetch-google-reviews.ts` `fetchPlaceData`.
 */
export async function fetchPlaceAddressData(
  placeId: string,
  apiKey: string
): Promise<FetchPlaceAddressResult | null> {
  const id = placeId.trim();
  if (!id) return null;

  const url = `https://places.googleapis.com/v1/places/${id}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': PLACE_FIELD_MASK,
      Referer: 'https://hero-pages.com',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Places API ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    formattedAddress?: string;
    addressComponents?: { longText?: string; types?: string[] }[];
  };
  if (!data.formattedAddress || !String(data.formattedAddress).trim()) {
    return null;
  }
  return {
    formattedAddress: data.formattedAddress.trim(),
    addressComponents: data.addressComponents,
  };
}

export type ApplyGooglePlaceAddressOptions = {
  /** When true, log every decision / failure reason to stderr. */
  debug?: boolean;
};

function debugLog(
  options: ApplyGooglePlaceAddressOptions | undefined,
  message: string
): void {
  if (options?.debug) {
    console.log(`  [place-address:debug] ${message}`);
  }
}

/**
 * When `business.googlePlacesId` is set and `GOOGLE_PLACES_API_KEY` is available,
 * fetches the formatted address and writes:
 * - `pages[].hero.card2Line1` / `card2Line2` for the `home` page (address / MapPin card in Hero.tsx)
 * - `business.locationAddress` from `addressComponents` (overwrites any previous values)
 *
 * @returns true if hero lines were updated from the API
 */
export async function applyGooglePlaceAddressToWebsiteEntry(
  websiteEntry: Record<string, unknown>,
  options?: ApplyGooglePlaceAddressOptions
): Promise<boolean> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) {
    const msg =
      'GOOGLE_PLACES_API_KEY not set — skip Google Places address fetch for hero';
    console.log(`  [place-address] ${msg}`);
    const rawLen = (process.env.GOOGLE_PLACES_API_KEY ?? '').length;
    debugLog(
      options,
      `env: GOOGLE_PLACES_API_KEY before trim length=${rawLen} (empty or missing after .trim()?)`
    );
    return false;
  }
  debugLog(
    options,
    `API key present (char length after trim: ${apiKey.length})`
  );

  const business = websiteEntry.business as Record<string, unknown> | undefined;
  const placeId = business?.googlePlacesId;
  const id = typeof placeId === 'string' ? placeId.trim() : '';
  if (!id) {
    debugLog(
      options,
      'no business.googlePlacesId (non-string or empty) — add business.googlePlacesId in websites.json (legacy page reviews id is not used here)'
    );
    return false;
  }
  debugLog(options, `place_id=${id}`);

  let placeData: FetchPlaceAddressResult | null;
  try {
    const url = `https://places.googleapis.com/v1/places/${id}`;
    debugLog(options, `GET ${url}`);
    placeData = await fetchPlaceAddressData(id, apiKey);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('  [place-address] Google Places request failed:', msg);
    return false;
  }

  if (!placeData) {
    console.log(
      '  [place-address] No formattedAddress in Places response — hero unchanged'
    );
    debugLog(
      options,
      'response had status 200 but formattedAddress was missing/blank (or JSON parse issue)'
    );
    return false;
  }
  {
    const j = JSON.stringify(placeData.formattedAddress);
    debugLog(
      options,
      j.length > 150
        ? `raw formattedAddress (first 150 chars): ${j.slice(0, 150)}…`
        : `raw formattedAddress: ${j}`
    );
  }

  const pages = websiteEntry.pages;
  if (!Array.isArray(pages)) {
    debugLog(options, `pages is not an array: ${typeof pages}`);
    return false;
  }
  if (pages.length === 0) {
    debugLog(options, 'pages is empty');
    return false;
  }
  const pageNames = pages.map((p) =>
    p && typeof p === 'object'
      ? String((p as { name?: string }).name ?? '∅')
      : typeof p
  );
  debugLog(options, `page name fields (order): [${pageNames.join(', ')}]`);
  let home = pages.find(
    (p) =>
      p && typeof p === 'object' && (p as { name?: string }).name === 'home'
  ) as Record<string, unknown> | undefined;
  if (!home && pages[0] && typeof pages[0] === 'object') {
    home = pages[0] as Record<string, unknown>;
    debugLog(
      options,
      "no page with name === 'home' — using pages[0] as home (recommend setting name: 'home' on the first page)"
    );
  }
  if (!home) {
    debugLog(options, 'could not resolve home page');
    return false;
  }
  const hero = home.hero as Record<string, unknown> | undefined;
  if (!hero) {
    debugLog(options, 'home page has no .hero object');
    return false;
  }

  const { line1, line2 } = splitFormattedAddressForHero(
    placeData.formattedAddress
  );
  if (!line1) {
    debugLog(options, 'splitFormattedAddressForHero produced empty line1');
    return false;
  }
  hero.card2Line1 = line1;
  hero.card2Line2 = line2;
  console.log(
    `  [place-address] Set home hero address card (card2) from Google Places: "${line1}"${line2 ? ` / "${line2}"` : ''}`
  );

  if (business) {
    const parsed = addressComponentsToLocationAddress(
      placeData.addressComponents
    );
    if (parsed && (parsed.street || parsed.postalCode || parsed.city)) {
      business.locationAddress = {
        street: parsed.street,
        postalCode: parsed.postalCode,
        city: parsed.city,
      };
      console.log(
        `  [place-address] Set business.locationAddress from addressComponents (replaces any previous values)`
      );
    } else {
      debugLog(
        options,
        'no usable addressComponents for locationAddress — left unchanged'
      );
    }
  }

  return true;
}
