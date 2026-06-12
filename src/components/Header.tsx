import { useState, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Phone, Mail, MessageCircle, Menu, X } from 'lucide-react';
import type { ResolvedPageData, HeaderNavLink, SrcPathFn } from '@/types/page';
import { ResponsiveImage } from '@/components/ResponsiveImage';
import { Button } from '@/components/ui/button';
import {
  LanguageSwitcher,
  type LanguageSwitcherDisplay,
} from '@/components/LanguageSwitcher';
import {
  type SupportedLanguage,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  withLang,
} from '@/lib/language';
import { buildSrcPath, type SrcPathInfo } from '@/lib/src-path';
import type { HeaderStrings } from '@/lib/client-island-strings';

interface HeaderProps {
  pageData: ResolvedPageData;
  language?: SupportedLanguage;
  /** Server-resolved UI strings (required for `client:*` islands). */
  strings: HeaderStrings;
  /** Server-only callers may pass a function. `client:*` islands MUST use `srcPathInfo` instead. */
  srcPath?: SrcPathFn;
  /** Serializable companion for `srcPath`; required when this component is hydrated as a `client:*` island. */
  srcPathInfo?: SrcPathInfo;
}

function shouldOpenInNewTab(href: string): boolean {
  const normalized = href.trim().toLowerCase();
  if (
    normalized.startsWith('mailto:') ||
    normalized.startsWith('tel:') ||
    normalized.startsWith('/') ||
    normalized.startsWith('#')
  ) {
    return false;
  }
  return (
    normalized.startsWith('http://') || normalized.startsWith('https://')
  );
}

type RawHeaderNavLink = HeaderNavLink & { url?: string };

/** Prefer `href` (current schema); fall back to legacy `url` from older exports. */
function headerLinkHref(link: RawHeaderNavLink): string {
  const h = link.href;
  if (typeof h === 'string' && h.length > 0) return h;
  const u = link.url;
  if (typeof u === 'string' && u.length > 0) return u;
  return typeof h === 'string' ? h : '';
}

function getHeaderLinks(pageData: ResolvedPageData): HeaderNavLink[] {
  const links = pageData?.header?.links;
  if (!Array.isArray(links)) return [];
  return links.filter((l) => l.visible !== false);
}

export const Header = ({
  pageData,
  language,
  strings,
  srcPath: srcPathProp,
  srcPathInfo,
}: HeaderProps) => {
  /** Rebuild the function from a serializable `srcPathInfo` so SSR and client agree (functions can't cross the island boundary). */
  const srcPath = useMemo<SrcPathFn | undefined>(() => {
    if (srcPathInfo) return (fragment: string) => buildSrcPath(srcPathInfo, fragment);
    return srcPathProp;
  }, [srcPathInfo, srcPathProp]);
  const whatsappButtonClass = 'bg-[#25D366] hover:bg-[#1ebe5d] text-white';
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [currentLang, setCurrentLang] = useState<SupportedLanguage>(
    language || DEFAULT_LANGUAGE
  );
  const headerLinks = getHeaderLinks(pageData);
  const { business } = pageData;
  const whatsappNumber = business.social?.whatsappNumber || '';

  const navLinks = headerLinks.filter((l) => !l.type || l.type === 'link');
  let buttonLinks = headerLinks.filter(
    (l) => l.type === 'button' || l.type === 'whatsapp'
  );
  const header = pageData?.header as Record<string, unknown> | undefined;
  const rawLogoWidth = header?.logoWidth;
  const parsedLogoWidth =
    typeof rawLogoWidth === 'number' && Number.isFinite(rawLogoWidth)
      ? Math.round(rawLogoWidth)
      : typeof rawLogoWidth === 'string'
        ? parseInt(rawLogoWidth, 10)
        : NaN;
  const logoWidth =
    !Number.isNaN(parsedLogoWidth) && parsedLogoWidth > 0
      ? parsedLogoWidth
      : undefined;
  const logoHref = `/${currentLang}`;
  const effectiveLogoWidth = logoWidth ?? 180;

  // Optional per-client logo horizontal offset (px). When set, overrides default `-ml-4 md:ml-0`.
  const rawLogoMarginLeft = header?.logoMarginLeft;
  const parsedLogoMarginLeft =
    typeof rawLogoMarginLeft === 'number' && Number.isFinite(rawLogoMarginLeft)
      ? Math.round(rawLogoMarginLeft)
      : typeof rawLogoMarginLeft === 'string' && rawLogoMarginLeft.trim() !== ''
        ? parseInt(rawLogoMarginLeft, 10)
        : NaN;
  const logoMarginLeft = Number.isFinite(parsedLogoMarginLeft)
    ? parsedLogoMarginLeft
    : undefined;
  const hasExplicitLogoMargin = logoMarginLeft !== undefined;

  // Spread each field only if defined; empty object = no style attribute (guarded at the img below).
  const logoInlineStyle: CSSProperties = {
    ...(logoWidth !== undefined && { width: `${logoWidth}px` }),
    ...(hasExplicitLogoMargin && { marginLeft: `${logoMarginLeft}px` }),
  };
  const hasLogoInlineStyle = Object.keys(logoInlineStyle).length > 0;

  // `header.languageDisplay`: "flag-name" | "name" | "code" | "flag"; omitted = default.
  const rawLanguageDisplay = header?.languageDisplay;
  const languageSwitcherDisplay: LanguageSwitcherDisplay | undefined =
    rawLanguageDisplay === 'flag-name' ||
    rawLanguageDisplay === 'name' ||
    rawLanguageDisplay === 'code' ||
    rawLanguageDisplay === 'flag'
      ? (rawLanguageDisplay as LanguageSwitcherDisplay)
      : undefined;

  if (buttonLinks.length === 0 && header) {
    const legacyButtons: HeaderNavLink[] = [];
    if (header.buttonUrl && header.buttonLabel) {
      legacyButtons.push({
        href: String(header.buttonUrl),
        label: String(header.buttonLabel),
        type: 'button',
      });
    }
    if (whatsappNumber) {
      legacyButtons.push({
        href: '',
        label: String(
          header.whatsappButtonLabel ?? header.whatsApp ?? 'WhatsApp'
        ),
        type: 'whatsapp',
        message: String(header.whatsappMessage ?? ''),
        ariaLabel: String(header.whatsappAria ?? header.whatsApp ?? 'WhatsApp'),
      });
    }
    buttonLinks = legacyButtons;
  }

  useEffect(() => {
    if (!language && typeof window !== 'undefined') {
      const pathLang = window.location.pathname.split('/')[1];
      if (SUPPORTED_LANGUAGES.includes(pathLang as SupportedLanguage)) {
        setCurrentLang(pathLang as SupportedLanguage);
      }
    } else if (language) {
      setCurrentLang(language);
    }
  }, [language]);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileMenuOpen]);

  const whatsappLink = buttonLinks.find((l) => l.type === 'whatsapp');
  const whatsappMessage = whatsappLink?.message ?? '';

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 w-full ${
        isScrolled
          ? 'bg-white/95 backdrop-blur-sm shadow-lg'
          : 'bg-white shadow-md'
      }`}
    >
      <div className="container mx-auto px-4 py-2 w-full">
        <div className="flex items-center justify-between w-full">
          <a href={logoHref} className="flex items-center gap-2">
            <ResponsiveImage
              preset="logo"
              src={strings.logoUrl}
              alt={strings.logoAlt}
              width={effectiveLogoWidth}
              height={48}
              className={`h-16 w-auto object-contain${
                hasExplicitLogoMargin ? '' : ' -ml-4 md:ml-0'
              }${logoWidth === undefined ? ' max-w-[180px]' : ''}`}
              {...(hasLogoInlineStyle && { style: logoInlineStyle })}
              role="img"
              aria-label={strings.logoAlt}
              {...(srcPath && {
                'data-hero-factory-src-path': srcPath('header.logoUrl'),
              })}
            />
          </a>

          <div className="hidden md:flex items-center gap-8">
            {navLinks.length > 0 && (
              <nav
                className="flex items-center gap-6 text-foreground"
                aria-label={strings.ariaLabelNavigation}
              >
                {navLinks.map((link, index) => (
                  <a
                    key={index}
                    href={withLang(headerLinkHref(link), currentLang)}
                    className="hover:text-primary transition-colors font-medium"
                    {...(srcPath && {
                      'data-hero-factory-src-path': srcPath(
                        `header.links.${index}.label`
                      ),
                    })}
                  >
                    {link.label}
                  </a>
                ))}
              </nav>
            )}
            <div className="flex items-center gap-3">
              {buttonLinks.map((link, index) => {
                if (link.type === 'whatsapp') {
                  if (!whatsappNumber) return null;
                  const waHref = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(link.message ?? '')}`;
                  return (
                    <Button
                      key={index}
                      size="lg"
                      className={`${whatsappButtonClass} px-6 py-3 rounded-full font-semibold text-base hover-lift`}
                      asChild
                    >
                      <a
                        href={waHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-2"
                        aria-label={link.ariaLabel ?? link.label}
                      >
                        <MessageCircle className="h-4 w-4" />
                        <span
                          {...(srcPath && {
                            'data-hero-factory-src-path': srcPath(
                              `header.links.${navLinks.length + index}.label`
                            ),
                          })}
                        >
                          {link.label}
                        </span>
                      </a>
                    </Button>
                  );
                }
                const targetHref = headerLinkHref(link);
                const isTel = targetHref.toLowerCase().startsWith('tel:');
                const isMail = targetHref.toLowerCase().startsWith('mailto:');
                return (
                  <Button
                    key={index}
                    size="lg"
                    className="bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-3 rounded-full font-semibold text-base hover-lift"
                    asChild
                  >
                    <a
                      href={withLang(targetHref, currentLang)}
                      {...(shouldOpenInNewTab(targetHref) && {
                        target: '_blank',
                        rel: 'noopener noreferrer',
                      })}
                      className="flex items-center justify-center gap-2"
                      aria-label={link.ariaLabel ?? link.label}
                    >
                      {isTel && <Phone className="h-4 w-4" aria-hidden="true" />}
                      {isMail && <Mail className="h-4 w-4" aria-hidden="true" />}
                      <span
                        {...(srcPath && {
                          'data-hero-factory-src-path': srcPath(
                            `header.links.${navLinks.length + index}.label`
                          ),
                        })}
                      >
                        {link.label}
                      </span>
                    </a>
                  </Button>
                );
              })}
            </div>
            <LanguageSwitcher
              currentLang={currentLang}
              variant="dropdown"
              display={languageSwitcherDisplay}
              selectLanguageLabel={strings.selectLanguageLabel}
            />
          </div>

          <div className="md:hidden flex items-center gap-2">
            <a
              href={`tel:${business.phone}`}
              className="flex items-center justify-center w-12 h-12 bg-primary hover:bg-primary/90 text-primary-foreground rounded-full transition-colors"
              aria-label={strings.callNowAriaLabel}
            >
              <Phone className="h-5 w-5" aria-hidden="true" />
            </a>
            {whatsappNumber && (
              <a
                href={`https://wa.me/${whatsappNumber}?text=${encodeURIComponent(whatsappMessage)}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`flex items-center justify-center w-12 h-12 ${whatsappButtonClass} rounded-full transition-colors`}
                aria-label={whatsappLink?.ariaLabel ?? 'WhatsApp'}
              >
                <MessageCircle className="h-5 w-5" aria-hidden="true" />
              </a>
            )}
            <button
              type="button"
              onClick={() => setMobileMenuOpen((open) => !open)}
              className="flex items-center justify-center w-12 h-12 rounded-full border border-gray-300 hover:bg-gray-50 transition-colors"
              aria-label={
                mobileMenuOpen
                  ? strings.ariaMenuClose
                  : strings.ariaMenuOpen
              }
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? (
                <X className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Menu className="h-5 w-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </div>

      {mobileMenuOpen && (
        <div
          className="md:hidden absolute top-full left-0 right-0 bg-white border-t border-gray-200 shadow-lg max-h-[calc(100vh-5rem)] overflow-y-auto"
          role="dialog"
          aria-label={strings.ariaLabelNavigation}
        >
          <nav
            className="container mx-auto px-4 py-4 flex flex-col gap-2"
            aria-label={strings.ariaLabelNavigation || 'Navigation'}
          >
            {navLinks.map((link, index) => (
              <a
                key={index}
                href={withLang(headerLinkHref(link), currentLang)}
                className="py-3 px-4 rounded-lg hover:bg-gray-50 text-foreground font-medium transition-colors"
                onClick={() => setMobileMenuOpen(false)}
              >
                {link.label}
              </a>
            ))}
            <div className="flex flex-col gap-2 pt-4 mt-2 border-t border-gray-100">
              {buttonLinks.map((link, index) => {
                if (link.type === 'whatsapp') {
                  if (!whatsappNumber) return null;
                  const waHref = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(link.message ?? '')}`;
                  return (
                    <Button
                      key={index}
                      size="lg"
                      className={`w-full ${whatsappButtonClass} rounded-full font-semibold`}
                      asChild
                    >
                      <a
                        href={waHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setMobileMenuOpen(false)}
                        className="flex items-center justify-center"
                      >
                        <MessageCircle className="h-4 w-4 mr-2 shrink-0" />
                        <span
                          {...(srcPath && {
                            'data-hero-factory-src-path': srcPath(
                              `header.links.${navLinks.length + index}.label`
                            ),
                          })}
                        >
                          {link.label}
                        </span>
                      </a>
                    </Button>
                  );
                }
                const targetHref = headerLinkHref(link);
                const isTel = targetHref.toLowerCase().startsWith('tel:');
                const isMail = targetHref.toLowerCase().startsWith('mailto:');
                return (
                  <Button
                    key={index}
                    size="lg"
                    className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-full font-semibold"
                    asChild
                  >
                    <a
                      href={withLang(targetHref, currentLang)}
                      {...(shouldOpenInNewTab(targetHref) && {
                        target: '_blank',
                        rel: 'noopener noreferrer',
                      })}
                      onClick={() => setMobileMenuOpen(false)}
                      className="flex items-center justify-center gap-2"
                    >
                      {isTel && <Phone className="h-4 w-4" aria-hidden="true" />}
                      {isMail && <Mail className="h-4 w-4" aria-hidden="true" />}
                      <span
                        {...(srcPath && {
                          'data-hero-factory-src-path': srcPath(
                            `header.links.${navLinks.length + index}.label`
                          ),
                        })}
                      >
                        {link.label}
                      </span>
                    </a>
                  </Button>
                );
              })}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
};
