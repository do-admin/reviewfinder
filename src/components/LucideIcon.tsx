import * as LucideIcons from 'lucide-react';
import type { LucideIcon as LucideIconType, LucideProps } from 'lucide-react';

type Props = LucideProps & {
  name?: string;
  fallback: LucideIconType;
};

const iconMap = LucideIcons as unknown as Record<string, LucideIconType | undefined>;

/**
 * Renders a Lucide icon by export name (PascalCase, e.g. "Leaf", "Heart").
 * Falls back to `fallback` if name is missing or not found.
 */
export const LucideIcon = ({ name, fallback: Fallback, ...rest }: Props) => {
  const Resolved = name && iconMap[name];
  const Cmp = typeof Resolved === 'function' ? Resolved : Fallback;
  return <Cmp {...rest} />;
};
