import type { LucideIcon } from 'lucide-react';
import {
  Award,
  BookOpen,
  Briefcase,
  Building2,
  Calendar,
  Camera,
  Car,
  CheckCircle,
  Clock,
  Euro,
  Gift,
  Heart,
  Home,
  Image,
  MapPin,
  Music,
  Phone,
  School,
  Sparkles,
  Star,
  Sun,
  TreePine,
  User,
  UserCircle2,
  Users,
  Utensils,
} from 'lucide-react';

/** Whitelist: AI may only set hero `cardNIcon` to one of these PascalCase names. */
const HERO_LUCIDE_MAP: Readonly<Record<string, LucideIcon>> = {
  Award,
  BookOpen,
  Briefcase,
  Building2,
  Calendar,
  Camera,
  Car,
  CheckCircle,
  Clock,
  Euro,
  Gift,
  Heart,
  Home,
  Image,
  MapPin,
  Music,
  Phone,
  School,
  Sparkles,
  Star,
  Sun,
  TreePine,
  User,
  UserCircle2,
  Users,
  Utensils,
} as const;

const DEFAULT_BY_SLOT: readonly [LucideIcon, LucideIcon, LucideIcon] = [
  Users,
  MapPin,
  Clock,
];

export type HeroCardSlot = 0 | 1 | 2;

/**
 * Resolves a hero card icon name to a component. Invalid or empty `name` uses the
 * per-slot default (card1 → Users, card2 → MapPin, card3 → Clock).
 */
export function resolveHeroCardIcon(
  name: string | undefined,
  slot: HeroCardSlot
): LucideIcon {
  const key = (name ?? '').trim();
  if (key && key in HERO_LUCIDE_MAP) {
    return HERO_LUCIDE_MAP[key]!;
  }
  return DEFAULT_BY_SLOT[slot]!;
}

/** Names allowed in prompts and JSON `cardNIcon` fields. */
export const HERO_LUCIDE_ICON_NAMES = Object.keys(HERO_LUCIDE_MAP).sort();
