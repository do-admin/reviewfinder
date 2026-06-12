'use client';

import React from 'react';
import { cn } from '@/lib/utils';

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface HeadingProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /**
   * Semantic heading level (1–6). Defaults to 1.
   */
  level?: HeadingLevel;

  /**
   * Visual tone / color. Defaults to "primary".
   */
  variant?: 'default' | 'primary' | 'accent' | 'muted';

  /**
   * Override the rendered tag while keeping accessible semantics.
   * Useful when you need an <h3> that should look like an <h1> etc.
   */
  as?: keyof React.JSX.IntrinsicElements;

  /**
   * Whether to show the underline decoration. Defaults to true.
   */
  underline?: boolean;

  /**
   * Custom className for the underline element.
   */
  underlineClassName?: string;

  /**
   * Whether to center the heading. Defaults to false.
   */
  center?: boolean;
}

/**
 * Flexible Heading component that keeps semantics & design in sync.
 *
 * Examples:
 *  <Heading level={1}>Page Title</Heading>
 *  <Heading level={3} variant="primary" className="mt-4">Section</Heading>
 *  <Heading level={2} showUnderline={false}>No Underline</Heading>
 */
export const Heading: React.FC<HeadingProps> = ({
  level = 1,
  variant = 'default',
  center = false,
  as,
  underline = false,
  underlineClassName = 'w-24 h-1 bg-accent rounded-full mx-auto mt-2',
  className,
  children,
  ...props
}) => {
  // Review site standard heading sizes
  const sizeMap: Record<HeadingLevel, string> = {
    1: 'text-3xl md:text-4xl', // 30px/36px - main page titles
    2: 'text-2xl md:text-3xl', // 24px/30px - section headings
    3: 'text-xl md:text-2xl', // 20px/24px - subsection headings
    4: 'text-lg md:text-xl', // 18px/20px - minor headings
    5: 'text-base md:text-lg', // 16px/18px - small headings
    6: 'text-sm md:text-base', // 14px/16px - smallest headings
  };

  const colorMap: Record<NonNullable<HeadingProps['variant']>, string> = {
    default: 'text-heading-foreground',
    primary: 'text-heading-foreground',
    accent: 'text-foreground',
    muted: 'text-muted-foreground',
  };

  const topMarginMap: Record<HeadingLevel, string> = {
    1: 'mt-6 md:mt-12',
    2: 'mt-6 md:mt-12',
    3: 'mt-6',
    4: 'mt-4',
    5: 'mt-2',
    6: 'mt-1',
  };

  const bottomMarginMap: Record<HeadingLevel, string> = {
    1: 'mb-6 md:mb-12',
    2: 'mb-6 md:mb-12',
    3: 'mb-6',
    4: 'mb-4',
    5: 'mb-2',
    6: 'mb-1',
  };

  const tagName = as || `h${level}`;
  const Component = tagName as keyof React.JSX.IntrinsicElements;

  // Check if custom margin classes are provided
  const hasCustomTopMargin = className?.includes('mt-');
  const hasCustomBottomMargin = className?.includes('mb-');

  return (
    <div>
      {React.createElement(
        Component,
        {
          ...props,
          lang: 'de',
          className: cn(
            'font-heading font-bold text-balance break-words hyphens-auto',
            sizeMap[level],
            // Only apply internal top margin if no custom top margin is provided
            !hasCustomTopMargin && topMarginMap[level],
            center && 'text-center',
            colorMap[variant],
            // Only apply internal bottom margin if no custom bottom margin is provided and no underline
            !hasCustomBottomMargin && !underline && bottomMarginMap[level],
            // After all classes such that they can override the default classes
            className
          ),
        },
        children
      )}
      {underline && (
        <div className={cn(underlineClassName, bottomMarginMap[level])}></div>
      )}
    </div>
  );
};
