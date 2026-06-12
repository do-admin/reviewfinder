import React from 'react';
import { Heading } from '@/components/Heading';
import { ResponsiveImage } from '@/components/ResponsiveImage';
import type { LegalContentBlock } from '@/types/page';
import { renderLegalInlinePart } from '@/lib/legal-inline-parts';

interface UeberUnsContentProps {
  blocks?: LegalContentBlock[];
}

const headingClass =
  'font-bold mb-4 text-balance leading-tight font-heading md:pt-0';
const h1Class = `mt-6 text-2xl md:text-4xl ${headingClass}`;
const h2Class = `mt-12 text-xl md:text-3xl ${headingClass}`;
const h3Class = `mt-10 text-xl md:text-2xl ${headingClass}`;

export default function UeberUnsContent({ blocks }: UeberUnsContentProps) {
  if (!blocks?.length) return null;
  return (
    <section className="prose prose-stone max-w-none">
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          const level = block.level ?? 2;
          const className =
            level === 1 ? h1Class : level === 2 ? h2Class : h3Class;
          return (
            <Heading key={i} level={level} className={`${className} mb-1`}>
              {block.text ?? ''}
            </Heading>
          );
        }
        if (block.type === 'image' && block.src) {
          return (
            <figure key={i} className="my-8 not-prose">
              <ResponsiveImage
                preset="content"
                src={block.src}
                alt={block.alt ?? ''}
                width={block.width}
                height={block.height}
                loading="lazy"
                className="w-full rounded-2xl object-cover"
              />
            </figure>
          );
        }
        if (block.type === 'paragraph' && block.parts?.length) {
          const isSubline = block.variant === 'subline';
          return (
            <p
              key={i}
              className={
                isSubline
                  ? 'mb-4 text-lg md:text-xl font-medium text-foreground/80 leading-snug'
                  : 'mb-8 leading-relaxed'
              }
            >
              {block.parts.map((part, j) => renderLegalInlinePart(part, j))}
            </p>
          );
        }
        if (block.type === 'paragraph' && block.text != null) {
          const isSubline = block.variant === 'subline';
          const isValueItem = block.text.trimStart().startsWith('<strong>');
          if (isValueItem) {
            return (
              <div key={i} className="flex items-start gap-3 mb-8">
                <span
                  className="mt-1.5 w-3 h-3 rounded-full bg-primary shrink-0"
                  aria-hidden="true"
                />
                <p
                  className="leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: block.text }}
                />
              </div>
            );
          }
          return (
            <p
              key={i}
              className={
                isSubline
                  ? 'mb-4 text-lg md:text-xl font-medium text-foreground/80 leading-snug'
                  : 'mb-8 leading-relaxed'
              }
              dangerouslySetInnerHTML={{ __html: block.text }}
            />
          );
        }
        return null;
      })}
    </section>
  );
}
