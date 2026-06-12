import type { Address, BusinessInfo } from '@/types/page';

const EMPTY: Address = { street: '', postalCode: '', city: '' };

export type DisplayAddressRoot = 'business.locationAddress';

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
  return { address: { ...EMPTY }, srcRoot: 'business.locationAddress' };
}
