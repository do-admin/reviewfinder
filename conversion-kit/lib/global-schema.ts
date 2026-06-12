/**
 * Global Organization and WebSite schema for every page.
 * Data is read from the active website entry's first page metadata.schema
 * in websites.json (single source of truth).
 */

import websitesDe from '@/data/websites.json';
import { buildSchemaJsonLd } from '@/lib/schema-org';
import type { WebsitesFile, WebsiteData } from '@/types/page';

const raw = websitesDe as unknown as WebsitesFile;
const websites: WebsiteData[] = Array.isArray(raw) ? raw : (raw.websites ?? []);

function normalizeDomain(value: string | undefined): string {
  if (!value) return '';
  const noProtocol = value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '');
  return noProtocol.split('/')[0].replace(/\/+$/, '').toLowerCase();
}

function getWebsiteById(siteId: string | undefined): WebsiteData | undefined {
  if (!siteId) return undefined;
  return websites.find((w) => w.id === siteId);
}

function getWebsiteBySiteUrl(
  siteUrl: string | undefined
): WebsiteData | undefined {
  if (!siteUrl) return undefined;
  const host = normalizeDomain(siteUrl);
  if (!host) return undefined;
  return websites.find((w) => {
    const deployHost = normalizeDomain(w.deployDomain);
    const clientHost = normalizeDomain(w.clientDomain);
    return deployHost === host || clientHost === host;
  });
}

type SiteSelectOptions = {
  siteId?: string;
  siteUrl?: string;
};

function getActiveWebsite(
  options?: SiteSelectOptions
): WebsiteData | undefined {
  const siteIdFromEnv =
    (import.meta.env.SITE_ID as string | undefined) ??
    process.env.SITE_ID ??
    '';

  return (
    getWebsiteById(options?.siteId) ??
    getWebsiteBySiteUrl(options?.siteUrl) ??
    getWebsiteById(siteIdFromEnv) ??
    websites[0]
  );
}

function getFirstPage(options?: SiteSelectOptions) {
  const website = getActiveWebsite(options);
  const page = website?.pages?.[0];
  return { website, page };
}

function getGlobalSchemaEntries(options?: SiteSelectOptions) {
  const { page } = getFirstPage(options);
  // Narrow the AnyPageData union — only some variants declare `metadata.schema`.
  const metadata = page?.metadata as
    | { schema?: Array<{ schemaType?: string; data?: unknown }> }
    | undefined;
  const schema = metadata?.schema;
  if (!Array.isArray(schema))
    return { organization: undefined, website: undefined };
  const organization = schema.find(
    (s) => s?.schemaType?.toLowerCase() === 'organization' && s?.data
  );
  const website = schema.find(
    (s) => s?.schemaType?.toLowerCase() === 'website' && s?.data
  );
  return {
    organization: organization?.data as Record<string, unknown> | undefined,
    website: website?.data as Record<string, unknown> | undefined,
  };
}

/** Default base URL for schema. `clientDomain` first, `deployDomain` fallback (canonical agrees with OG/canonical). */
export function getDefaultSiteUrl(siteId?: string): string {
  const topLevelDomain = !Array.isArray(raw) ? raw.clientDomain : undefined;
  const website = getActiveWebsite({ siteId });
  const domain =
    website?.clientDomain ?? website?.deployDomain ?? topLevelDomain;
  if (!domain) return '';
  return domain.startsWith('http') ? domain : `https://${domain}`;
}

/** Build Organization JSON-LD for the site. Use with prebuilt. */
export function getOrganizationSchema(
  siteUrl: string,
  siteId?: string
): Record<string, unknown> {
  const { organization } = getGlobalSchemaEntries({ siteId, siteUrl });
  if (!organization) return {};
  return buildSchemaJsonLd('organization', organization, { siteUrl });
}

/** Build WebSite JSON-LD for the site. Use with prebuilt. */
export function getWebsiteSchema(
  siteUrl: string,
  siteId?: string
): Record<string, unknown> {
  const { website } = getGlobalSchemaEntries({ siteId, siteUrl });
  if (!website) return {};
  return buildSchemaJsonLd('website', website, { siteUrl });
}

/** Pre-built global schemas (Organization + WebSite) for SchemaOrg prebuilt prop. */
export function getGlobalSchemaPrebuilt(
  siteUrl: string,
  siteId?: string
): Array<Record<string, unknown>> {
  const org = getOrganizationSchema(siteUrl, siteId);
  const site = getWebsiteSchema(siteUrl, siteId);
  const out: Array<Record<string, unknown>> = [];
  if (Object.keys(org).length > 0) out.push(org);
  if (Object.keys(site).length > 0) out.push(site);
  return out;
}
