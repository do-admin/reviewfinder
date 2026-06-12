import React from 'react';
import type { LegalInlinePart } from '@/types/page';

/** Renders one inline fragment from legal / Über-uns / Impressum JSON blocks. */
export function renderLegalInlinePart(
  part: LegalInlinePart,
  key: string | number
): React.ReactNode {
  const reactKey = 'id' in part && part.id ? part.id : key;
  switch (part.type) {
    case 'text':
      return <React.Fragment key={reactKey}>{part.value}</React.Fragment>;
    case 'br':
      return <br key={reactKey} />;
    case 'strong':
      if (part.parts?.length) {
        return (
          <strong key={reactKey}>
            {part.parts.map((p, i) => renderLegalInlinePart(p, p.id ?? i))}
          </strong>
        );
      }
      return part.value != null ? (
        <strong key={reactKey}>{part.value}</strong>
      ) : null;
    case 'em':
      return <em key={reactKey}>{part.value}</em>;
    case 'link':
      return (
        <a
          key={reactKey}
          href={part.href}
          target={part.target}
          rel={
            part.rel ?? (part.target === '_blank' ? 'noopener noreferrer' : undefined)
          }
          className="text-primary hover:underline"
        >
          {part.value}
        </a>
      );
    default:
      return null;
  }
}
