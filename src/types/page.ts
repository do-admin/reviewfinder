import type { SupportedLanguage } from '@/lib/language';

// ---------------------------------------------------------------------------
// Business info – single source of truth for identity, contact, location
// ---------------------------------------------------------------------------

export interface Address {
  street: string;
  postalCode: string;
  city: string;
}

export interface BusinessLocation {
  city: string;
  district: string;
  neighborhood: string;
}

export interface BusinessOpeningHours {
  short: string;
  detailed: string;
  display: string;
}

export interface BusinessContactPerson {
  name: string;
  title: string;
  imageUrl: string;
}

export interface BusinessSocial {
  instagram?: string;
  facebook?: string;
  whatsappNumber?: string;
}

export interface BusinessInfo {
  name: string;
  brandName: string;
  legalName?: string;
  location: BusinessLocation;
  /**
   * Registered / legal imprint address (Gewerbeanmeldung etc.).
   * Used only for Impressum (and as Excel “impressum *” import target). Not for hero/map/contact.
   */
  legalAddress: Address;
  /**
   * Operating / studio address (e.g. from Google Places). Shown in hero, contact, footer, map, and schema
   * when set. Filled by fetch-place-hero or excel/briefing, not the same as `legalAddress`.
   */
  locationAddress?: Address;
  phone: string;
  /**
   * Impressum / Datenschutz phone when it should differ from `phone`.
   * Falls back to `phone` when omitted.
   */
  phoneLegal?: string;
  email: string;
  /**
   * Impressum / Datenschutz contact email when it should differ from `email`
   * (e.g. general inbox vs. legal). Falls back to `email` when omitted.
   */
  legalEmail?: string;
  openingHours: BusinessOpeningHours;
  contactPerson: BusinessContactPerson;
  /** URL for booking/inquiry (e.g. Calendly or contact page). */
  bookingUrl?: string;
  social: BusinessSocial;
  /** Google Places place_id — maps embed, reviews fetch, schema. Single source of truth (not on page.reviews). */
  googlePlacesId?: string;
  ustId?: string;
  registergericht?: string;
  hrbNummer?: string;
  vertreter?: string;
}

// ---------------------------------------------------------------------------
// Page section props – only section-specific content, no business data
// ---------------------------------------------------------------------------

export interface FAQ {
  question: string;
  answer: string;
}

export interface FAQSectionProps {
  title: string;
  subtitle: string;
  /** Present in JSON when inlined; otherwise filled at build from `faqDataFile` (see index.astro). */
  faqs?: FAQ[];
  /**
   * When omitted or `true` (default), the section uses `bg-muted` and card-style accordions.
   * Set to `false` for `bg-background` with `bg-muted` accordion rows (classic stripe).
   */
  mutedSectionBackground?: boolean;
}

export interface HeroButton {
  text: string;
  link: string;
  variant?: 'primary' | 'outline';
}

export interface HeroProps {
  /** Full H1 override. When set, used instead of locationPrefix + suburb + locationSuffix. */
  h1?: string;
  suburb?: string;
  /** Optional pull-quote. */
  quote?: string;
  backgroundImage: string;
  backgroundImageAlt: string;
  /** Symmetric highlight cards: icon (Lucide name) + one or two text lines. Empty card = hidden. */
  card1Icon: string;
  card1Line1: string;
  card1Line2: string;
  card2Icon: string;
  card2Line1: string;
  card2Line2: string;
  card3Icon: string;
  card3Line1: string;
  card3Line2: string;
  buttons?: HeroButton[];
  /** Custom CSS color for the H1 text. When set, overrides the default `text-primary` class. Any valid CSS color value (hex, rgb, hsl, named). */
  h1Color?: string;
  /** Override URL for the hero address card. Default: `#map` (scrolls to the map section on this page). */
  addressUrl?: string;
  /** Override URL for the hero opening-hours card. Default: `#opening-hours` (Contact). */
  openingHoursUrl?: string;
}

export interface InfoProps {
  description: string;
  textHeading?: string;
  paragraph1: string;
  paragraph2: string;
  quote: string;
  imageUrl: string;
  imageAlt: string;
  activities: { title: string; description: string; icon?: string };
  nutrition: { title: string; description: string; icon?: string };
  garden: { title: string; description: string; icon?: string };
  values: {
    mindfulness: string;
    nature: string;
    participation: string;
  };
  /** Lucide icon names (PascalCase) for the three value cards — mindfulness, nature, participation. */
  valueIcons?: {
    mindfulness?: string;
    nature?: string;
    participation?: string;
  };
}

export interface GalleryImage {
  src: string;
  alt: string;
}

export interface GalleryProps {
  title: string;
  subtitle: string;
  images: GalleryImage[];
  roomsTitle: string;
  roomsDescription: string;
  outdoorTitle: string;
  outdoorDescription: string;
  copyright?: string;
}

export interface TeamProps {
  title: string;
  subtitle: string;
  teamMember: { quote: string };
  teamDescription?: string;
  meetAndGreet?: string;
}

export interface MapProps {
  description: string;
  publicTransport: string;
  parking: string;
  mapEmbedUrl: string;
  pageDescription?: string;
}

interface Review {
  name: string;
  relativePublishTimeDescription: string;
  rating: number;
  text: { text: string; languageCode: string };
  originalText: { text: string; languageCode: string };
  authorAttribution: {
    displayName: string;
    uri: string;
    photoUri?: string;
  };
  publishTime: string;
  googleMapsUri: string;
  flagContentUri: string;
}

export interface ReviewData {
  formattedAddress: string;
  displayName: { text: string; languageCode: string };
  reviews?: Review[];
  userRatingCount: number;
  rating: number;
}

export interface GoogleReviewsProps {
  title: string;
  subtitle: string;
  reviewData: ReviewData;
  minimumRating?: number;
  maxDisplayCount?: number;
  reviewerRoleLabel?: string;
}

// ---------------------------------------------------------------------------
// Page metadata & SEO
// ---------------------------------------------------------------------------

export interface PageMetadata {
  title: string;
  description: string;
  keywords: string;
  openGraph: {
    title: string;
    description: string;
    url: string;
    images: Array<{
      url: string;
      width: number;
      height: number;
      alt: string;
    }>;
  };
  twitter: {
    title: string;
    description: string;
    images: string[];
  };
  geo: {
    region: string;
    placename: string;
    position: string;
    icbm: string;
  };
  schema?: Array<{
    id: string;
    schemaType: string;
    data: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Schema.org types
// ---------------------------------------------------------------------------

export interface OrganizationSchemaAddress {
  name?: string;
  streetAddress: string;
  postalCode: string;
  addressLocality: string;
  addressRegion: string;
  addressCountry: string;
}

export interface OrganizationSchemaContactPoint {
  telephone: string;
  email: string;
  contactType: string;
  availableLanguage: string[];
  areaServed: string;
}

export interface OfferCatalogItem {
  name: string;
  description?: string;
  url?: string;
}

export interface OfferCatalog {
  name: string;
  itemListElement: OfferCatalogItem[];
}

export interface OrganizationSchema {
  name: string;
  legalName: string;
  alternateName: string[];
  description: string;
  telephone: string;
  email: string;
  url: string;
  logo: string;
  taxID?: string;
  address: OrganizationSchemaAddress[];
  contactPoint: OrganizationSchemaContactPoint[];
  sameAs: string[];
  foundingLocation: {
    name: string;
    address: OrganizationSchemaAddress;
  };
  founder: Array<{ name: string }>;
  identifier: Array<{ propertyID: string; value: string }>;
  knowsAbout: string[];
  slogan: string;
  priceRange: string;
  hasOfferCatalog?: OfferCatalog;
}

// ---------------------------------------------------------------------------
// Page & website structure
// ---------------------------------------------------------------------------

export interface PageData {
  name: string;
  displayName?: string;
  metadata: PageMetadata;
  hero: HeroProps;
  info: InfoProps;
  gallery: GalleryProps;
  team: TeamProps;
  map: MapProps;
  reviews: GoogleReviewsProps;
  faq: FAQSectionProps;
}

export interface RatgeberPageData {
  name: 'ratgeber';
  metadata: {
    title: string;
    description: string;
    keywords: string;
  };
  canonical: string;
  hero: { h1: string; lead: string };
  sections: Array<{
    heading: string;
    lead?: string;
    cta?: { href: string; text: string };
  }>;
  labels: {
    readingTime: string;
    noArticles: string;
    noCategory: string;
  };
  schema: Array<{
    id: string;
    schemaType: string;
    data: Record<string, unknown>;
  }>;
}

export interface FaqXxlGroup {
  group_name: string;
  faqs: FAQ[];
}

export interface FaqXxlPageData {
  name: 'faq';
  pageTitle: string;
  metadata: {
    title: string;
    description: string;
    keywords?: string;
    openGraph?: PageMetadata['openGraph'];
    twitter?: PageMetadata['twitter'];
  };
  hero: { h1: string; lead: string };
  faqDataFile: string;
  schema: Array<{
    id: string;
    schemaType: string;
    data: Record<string, unknown>;
  }>;
}

export type AnyPageData =
  | PageData
  | RatgeberPageData
  | FaqXxlPageData
  | LegalPageData;

// ---------------------------------------------------------------------------
// Legal content blocks (shared by impressum & datenschutz)
// ---------------------------------------------------------------------------

/**
 * Inline content parts for legal blocks. Form-friendly: parts arrays support
 * any length; add parts dynamically. Optional `id` binds parts to form fields.
 */
export type LegalInlinePart =
  | { type: 'text'; value: string; id?: string }
  | { type: 'br'; id?: string }
  | { type: 'strong'; value?: string; parts?: LegalInlinePart[]; id?: string }
  | { type: 'em'; value: string; id?: string }
  | {
      type: 'link';
      href: string;
      value: string;
      target?: string;
      rel?: string;
      id?: string;
    };

/**
 * Block (heading or paragraph) for legal pages. Form-friendly: paragraphs
 * should use `parts` (arbitrary length); simple text = [{ type: "text", value }].
 */
export interface LegalContentBlock {
  type: 'heading' | 'paragraph' | 'image';
  /** 1–3: Über-uns may use 1 for in-content title; legal pages often use 2–3 */
  level?: 1 | 2 | 3;
  /** Plain text – used for headings and legacy paragraphs */
  text?: string;
  /**
   * Paragraph presentation hint (currently used by Über-uns).
   * - default: normal paragraph
   * - subline: short lead-in line shown between heading and paragraph
   */
  variant?: 'default' | 'subline';
  /** Structured content parts – preferred for paragraphs; supports any number of parts */
  parts?: LegalInlinePart[];
  srcFragment?: string;
  /** Image source URL – used when type is 'image' */
  src?: string;
  /** Image alt text – used when type is 'image' */
  alt?: string;
  /** Image width in pixels – used when type is 'image' */
  width?: number;
  /** Image height in pixels – used when type is 'image' */
  height?: number;
}

export interface LegalPageContent {
  pageTitle?: string;
  pageHeading?: string;
  /**
   * Über-uns: short visible hero H1 (above the blocks). When set, the page uses
   * this for the main heading; `pageTitle` remains for doc title / nav / breadcrumbs.
   */
  h1?: string;
  blocks?: LegalContentBlock[];
}

export interface LegalPageData {
  name: 'impressum' | 'datenschutz' | 'ueber-uns';
  pageTitle: string;
  /** Über-uns only: visible hero H1. Optional on impressum/datenschutz (unused). */
  h1?: string;
  metadata: {
    title: string;
    description: string;
    keywords?: string;
    openGraph?: PageMetadata['openGraph'];
    twitter?: PageMetadata['twitter'];
    schema?: PageMetadata['schema'];
  };
  /**
   * Impressum/Datenschutz body is generated from `src/data/_template/legal/*-content.json`
   * and may omit `blocks` entirely. Über-uns still uses `blocks` from JSON.
   */
  blocks?: LegalContentBlock[];
}

// ---------------------------------------------------------------------------
// Website data & file format
// ---------------------------------------------------------------------------

/** Section IDs that can be toggled in sectionVisibility. Omit = visible (true). */
export type SectionId =
  | 'hero'
  | 'info'
  | 'gallery'
  | 'team'
  | 'faq'
  | 'reviews'
  | 'map'
  | 'contact'
  | 'trust';

/** A section entry in the top-level sectionIds array of websites.json. */
export interface SectionConfig {
  id: SectionId;
  /** Default visibility for all websites. Individual websites can still override via sectionVisibility. */
  visible: boolean;
}

/** Per-section visibility. Only list sections to hide (false). Omitted sections are visible. */
export type SectionVisibility = Partial<Record<SectionId, boolean>>;

export type HeaderLinkType = 'link' | 'button' | 'whatsapp';

export interface HeaderNavLink {
  label: string;
  /** Link target. Legacy exports may use `url` instead; Header resolves both. */
  href: string;
  /** @deprecated Use `href`. Still read by Header for older data. */
  url?: string;
  type?: HeaderLinkType;
  /** When false the link is excluded from rendering. Defaults to true when omitted. */
  visible?: boolean;
  /** Prefilled message for WhatsApp link (type: "whatsapp") */
  message?: string;
  /** Aria label override */
  ariaLabel?: string;
}

export interface ImpressumBacklink {
  title: string;
  link: string;
  headingTitle: string;
}

export type DatenschutzResponsibleMode = 'client' | 'heroPages';

/** Controls Impressum source: client blocks from `websites.json` vs. generated Hero Pages Inc. content. */
export type ImpressumResponsibleMode = 'client' | 'heroPages';

export interface WebsiteData {
  id: string;
  deployDomain?: string;
  clientDomain?: string;
  googleTagId?: string;
  /** Controls who is listed as responsible entity in generated Datenschutz page. */
  datenschutzResponsibleMode?: DatenschutzResponsibleMode;
  /** Controls whether Impressum uses client `websites.json` blocks or Hero Pages Inc. template. */
  impressumResponsibleMode?: ImpressumResponsibleMode;
  business: BusinessInfo;
  /** Which main content sections to show. Omitted sections default to visible. */
  sectionVisibility?: SectionVisibility;
  /** Site header: `logoUrl`, `logoAlt`, optional `logoWidth` (px, displayed width), `links`, etc. */
  header?: Record<string, unknown> & {
    links?: HeaderNavLink[];
    logoWidth?: number;
  };
  contact?: Record<string, unknown>;
  footer?: Record<string, unknown>;
  cookie?: Record<string, unknown>;
  notFound?: Record<string, unknown>;
  trust?: Record<string, unknown>;
  disclaimer?: Record<string, unknown>;
  index?: Record<string, unknown>;
  cityExample?: Record<string, unknown>;
  /** Shared UI strings (e.g. `selectLanguage`). Used by common translation helpers. */
  common?: Record<string, unknown>;
  impressumBacklink?: ImpressumBacklink;
  pages: AnyPageData[];
}

export type WebsitesFile =
  | WebsiteData[]
  | {
      driveFolderId?: string;
      clientName?: string;
      clientDomain?: string;
      sectionIds?: SectionConfig[];
      websites: WebsiteData[];
    };

// ---------------------------------------------------------------------------
// Resolved page data – merged website + page, used by all components
// ---------------------------------------------------------------------------

export interface ResolvedPageData {
  id: string;
  deployDomain?: string;
  clientDomain: string;
  googleTagId?: string;
  datenschutzResponsibleMode?: DatenschutzResponsibleMode;
  impressumResponsibleMode?: ImpressumResponsibleMode;
  business: BusinessInfo;
  language?: SupportedLanguage;

  /** Site header: `logoUrl`, `logoAlt`, optional `logoWidth` (px, displayed width), `links`, etc. */
  header?: Record<string, unknown> & {
    links?: HeaderNavLink[];
    logoWidth?: number;
  };
  contact?: Record<string, unknown>;
  footer?: Record<string, unknown>;
  cookie?: Record<string, unknown>;
  notFound?: Record<string, unknown>;
  trust?: Record<string, unknown>;
  disclaimer?: Record<string, unknown>;
  index?: Record<string, unknown>;
  cityExample?: Record<string, unknown>;
  datenschutz?: LegalPageContent;
  impressum?: LegalPageContent;
  ueberUns?: LegalPageContent;
  impressumBacklink?: ImpressumBacklink;

  metadata: PageMetadata;
  hero: HeroProps;
  /** Resolved section visibility (defaults: all true). Used by layout to show/hide sections. */
  sectionVisibility: SectionVisibility;
  info: InfoProps;
  gallery: GalleryProps;
  team: TeamProps;
  map: MapProps;
  reviews: GoogleReviewsProps;
  faq: FAQSectionProps;
}

// ---------------------------------------------------------------------------
// Utility types for Hero Factory src-path
// ---------------------------------------------------------------------------

export type SrcPathFn = (fragment: string) => string;
