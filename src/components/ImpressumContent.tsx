import React from 'react';
import { Heading } from '@/components/Heading';
import type { LegalContentBlock } from '@/types/page';
import { renderLegalInlinePart } from '@/lib/legal-inline-parts';

interface ImpressumContentProps {
  blocks?: LegalContentBlock[];
}

const headingClass =
  'font-bold mb-6 text-balance leading-tight font-heading md:pt-0';
const h2Class = `mt-4 text-xl md:text-3xl ${headingClass}`;
const h3Class = `mt-4 text-xl md:text-2xl ${headingClass}`;

export default function ImpressumContent({ blocks }: ImpressumContentProps) {
  if (!blocks?.length) return null;
  return (
    <section id="impressum" className="prose prose-stone max-w-none">
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          const level = (block.level ?? 2) as 2 | 3;
          const className = level === 2 ? h2Class : h3Class;
          return (
            <Heading key={i} level={level} className={className}>
              {block.text ?? ''}
            </Heading>
          );
        }
        if (block.parts?.length) {
          return (
            <p key={i} className="mb-4">
              {block.parts.map((part, j) => renderLegalInlinePart(part, j))}
            </p>
          );
        }
        return (
          <p key={i} className="mb-4">
            {block.text ?? ''}
          </p>
        );
      })}
    </section>
  );
}
