import type { APIRoute } from 'astro';
import { normalizePublicUrl } from '@/lib/site-url';

export const GET: APIRoute = ({ site }) => {
  const raw = site?.toString() ?? '';
  const siteUrl = raw ? normalizePublicUrl(raw.replace(/\/$/, '')) : '';
  const content = `User-agent: *
Disallow:

Sitemap: ${siteUrl}/sitemap.xml
`;

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};
