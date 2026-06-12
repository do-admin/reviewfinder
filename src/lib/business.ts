import type { Address, BusinessInfo } from '@/types/page';

/**
 * Format an E.164 phone number for human-readable display with spaces.
 * The machine value (tel: href, schema.org telephone) is left untouched —
 * only call this for visible UI labels.
 *
 * Examples:
 *   +491725813431  →  +49 172 5813431
 *   +27217901234   →  +27 21 7901234
 *   +4930123456    →  +49 30 123456
 *
 * Strategy: strip country code, then split national number into a short
 * prefix (3 digits for long nationals like German mobiles, 2 for shorter
 * ones) and the remainder. Falls back to the raw value for anything that
 * doesn't start with "+".
 */
export function formatPhoneForDisplay(raw: string | undefined | null): string {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('+')) return s;

  const digits = s.slice(1).replace(/\D/g, '');

  // Country-code length heuristic: NANP (+1) = 1 digit, most others = 2,
  // some smaller nations = 3. We only need to handle the common cases.
  let ccLen = 2;
  if (digits.startsWith('1')) ccLen = 1;

  const cc = digits.slice(0, ccLen);
  const national = digits.slice(ccLen);
  if (!national) return s;

  // Use a 3-digit prefix for long national numbers (German mobiles etc.),
  // 2-digit for shorter ones (city area codes).
  const prefixLen = national.length > 9 ? 3 : 2;
  const prefix = national.slice(0, prefixLen);
  const rest = national.slice(prefixLen);

  return rest ? `+${cc} ${prefix} ${rest}` : `+${cc} ${prefix}`;
}

const EMPTY_ADDRESS: Address = { street: '', postalCode: '', city: '' };

/** `business.locationAddress` (operating / studio) — the only public-facing address. */
export type DisplayAddressRoot = 'business.locationAddress';

/**
 * Public UI + LocalBusiness: **only** `locationAddress` (not `legalAddress` / Impressum).
 * When fields are empty, the returned `address` is an empty `Address` (sr still points at `locationAddress`).
 */
export function getDisplayAddress(business: BusinessInfo): {
  address: Address;
  srcRoot: DisplayAddressRoot;
} {
  const loc = business.locationAddress;
  if (
    loc &&
    typeof loc === 'object' &&
    ((typeof loc.street === 'string' && loc.street.trim().length > 0) ||
      (typeof loc.postalCode === 'string' && loc.postalCode.trim().length > 0) ||
      (typeof loc.city === 'string' && loc.city.trim().length > 0))
  ) {
    return {
      address: {
        street: String(loc.street ?? '').trim(),
        postalCode: String(loc.postalCode ?? '').trim(),
        city: String(loc.city ?? '').trim(),
      },
      srcRoot: 'business.locationAddress',
    };
  }
  return { address: { ...EMPTY_ADDRESS }, srcRoot: 'business.locationAddress' };
}
