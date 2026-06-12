import { defineCollection, z } from 'astro:content';

const ratgeberCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    // Note: 'slug' in frontmatter is ignored - Astro auto-generates slug from filename
    // We keep it here as a passthrough for backwards compatibility but use entry.slug
    'meta-description': z.string(),
    'meta-keywords': z.string().optional(),
    'date-published': z.string(),
    'date-written': z.string().optional(),
    isFeatured: z.string().optional().default('false'),
    category: z.string().optional().default('Ratgeber'),
    author: z.string().optional(),
    'author-image': z.string().optional(),
    'article-image': z.string().optional(),
    'focus-keyphrase': z.string().optional(),
  }),
});

export const collections = {
  ratgeber: ratgeberCollection,
};
