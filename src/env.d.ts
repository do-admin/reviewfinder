/// <reference path="../.astro/types.d.ts" />
/// <reference types="react" />
/// <reference types="react-dom" />

interface ImportMetaEnv {
  readonly SITE_ID?: string;
  readonly PAGE_ID?: string;
  readonly KITA_ID?: string;
  readonly DEV?: boolean;
  /** Browser key with Maps Embed API enabled; used for `place_id:` embeds from `business.googlePlacesId`. */
  readonly PUBLIC_GOOGLE_MAPS_EMBED_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
