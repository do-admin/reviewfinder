/**
 * Cross-platform country-flag icon. Inline SVGs because Windows browsers
 * don't ship a country-flag emoji font (🇩🇪 falls back to literal "DE").
 * Unknown languages render as a language-code pill, never as text.
 */
import type { SupportedLanguage } from '@/lib/language';

interface FlagIconProps {
  lang: SupportedLanguage;
  /** Pass explicit width AND height (e.g. `h-4 w-6`); avoids aspect-ratio surprises. */
  className?: string;
  /** Accessible label; defaults to `<LANG> flag`. */
  title?: string;
}

export function FlagIcon({ lang, className = 'h-4 w-6', title }: FlagIconProps) {
  const flag = FLAGS[lang];
  const label = title ?? `${lang.toUpperCase()} flag`;
  if (!flag) {
    return (
      <span
        role="img"
        aria-label={label}
        className={`inline-flex items-center justify-center rounded-[2px] bg-muted text-foreground text-[0.625rem] font-semibold leading-none ${className}`}
      >
        {lang.toUpperCase()}
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      className={`inline-block shrink-0 overflow-hidden rounded-[2px] align-middle ${className}`}
      dangerouslySetInnerHTML={{ __html: flag }}
    />
  );
}

// Minimal inline SVG per supported language; `preserveAspectRatio="none"` lets the wrapper size them.
const FLAGS: Record<string, string> = {
  // Germany: black/red/gold horizontal stripes.
  de: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 3" preserveAspectRatio="none" width="100%" height="100%">
      <rect width="5" height="1" y="0" fill="#000000"/>
      <rect width="5" height="1" y="1" fill="#DD0000"/>
      <rect width="5" height="1" y="2" fill="#FFCE00"/>
    </svg>`,
  // United Kingdom (Union Jack).
  en: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30" preserveAspectRatio="none" width="100%" height="100%">
      <clipPath id="uk-a"><path d="M0,0 v30 h60 v-30 z"/></clipPath>
      <clipPath id="uk-b"><path d="M30,15 h30 v15 z v-15 h-30 z h-30 v-15 z v15 h30 z"/></clipPath>
      <g clip-path="url(#uk-a)">
        <rect width="60" height="30" fill="#012169"/>
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#ffffff" stroke-width="6"/>
        <path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#uk-b)" stroke="#C8102E" stroke-width="4"/>
        <path d="M30,0 V30 M0,15 H60" stroke="#ffffff" stroke-width="10"/>
        <path d="M30,0 V30 M0,15 H60" stroke="#C8102E" stroke-width="6"/>
      </g>
    </svg>`,
  // Albania: red field with black double-headed eagle (simplified geometric eagle).
  sq: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 100" preserveAspectRatio="none" width="100%" height="100%">
      <rect width="140" height="100" fill="#E41E20"/>
      <g fill="#000000" transform="translate(70 50)">
        <path d="M -22 -2 q 8 -18 22 -18 q 14 0 22 18 q -4 -6 -10 -8 q -2 6 -6 10 q 4 4 6 10 q -2 10 -12 12 q -10 -2 -12 -12 q 2 -6 6 -10 q -4 -4 -6 -10 q -6 2 -10 8 z"/>
      </g>
    </svg>`,
  // Ukraine: blue over yellow.
  uk: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" preserveAspectRatio="none" width="100%" height="100%">
      <rect width="3" height="1" y="0" fill="#0057B7"/>
      <rect width="3" height="1" y="1" fill="#FFD700"/>
    </svg>`,
  // Turkey: red field with white crescent + star.
  tr: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" preserveAspectRatio="none" width="100%" height="100%">
      <rect width="1200" height="800" fill="#E30A17"/>
      <circle cx="425" cy="400" r="200" fill="#ffffff"/>
      <circle cx="475" cy="400" r="160" fill="#E30A17"/>
      <polygon points="583.5,400 649.3,378.6 608.7,434.5 608.7,365.5 649.3,421.4" fill="#ffffff"/>
    </svg>`,
  // Saudi Arabia: green field with Shahada + sword — simplified to a plain green field
  // with a small white bar that reads as a sword silhouette.
  ar: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 2" preserveAspectRatio="none" width="100%" height="100%">
      <rect width="3" height="2" fill="#006C35"/>
      <rect x="0.5" y="1.3" width="2" height="0.08" fill="#ffffff"/>
      <path d="M 0.5 1.2 L 0.7 1.1 L 0.7 1.3 Z" fill="#ffffff"/>
    </svg>`,
  // India: orange / white / green with the Ashoka Chakra (simplified concentric ring).
  hi: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600" preserveAspectRatio="none" width="100%" height="100%">
      <rect width="900" height="200" y="0" fill="#FF9933"/>
      <rect width="900" height="200" y="200" fill="#ffffff"/>
      <rect width="900" height="200" y="400" fill="#138808"/>
      <circle cx="450" cy="300" r="78" fill="none" stroke="#000080" stroke-width="8"/>
      <circle cx="450" cy="300" r="16" fill="#000080"/>
    </svg>`,
};
