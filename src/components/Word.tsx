import React from 'react';
import { cn } from '@/lib/utils';

export type WordProps<T extends keyof React.JSX.IntrinsicElements = 'p'> = {
  as?: T;
  /** When set, renders `data-hero-factory-src-path` for the Hero Factory text editor. Use only when `children` are plain text (no icons or extra element siblings). */
  dataHeroFactorySrcPath?: string;
} & Omit<React.ComponentPropsWithoutRef<T>, 'as'>;

/**
 * Wrapper for user-facing text so the text editor can target editable nodes via
 * `data-hero-factory-src-path`. Use `as` for the HTML element (`p`, `div`, `span`, headings, `a`, …).
 */
export function Word<T extends keyof React.JSX.IntrinsicElements = 'p'>(
  props: WordProps<T>
) {
  const { as, dataHeroFactorySrcPath, className, children, ...rest } = props;
  const Tag = (as ?? 'p') as keyof React.JSX.IntrinsicElements;

  return React.createElement(
    Tag,
    {
      className: cn(className),
      ...(dataHeroFactorySrcPath
        ? { 'data-hero-factory-src-path': dataHeroFactorySrcPath }
        : {}),
      ...rest,
    },
    children
  );
}
