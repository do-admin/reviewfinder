import { useState, useEffect } from 'react';
import {
  type SupportedLanguage,
  SUPPORTED_LANGUAGES,
  getLanguageConfig,
  DEFAULT_LANGUAGE,
} from '@/lib/language';
import { resolvePageNameFromPathSegment, getLocalizedSlug } from '@/lib/route-slugs';
import { FlagIcon } from '@/components/FlagIcon';

const DEFAULT_SELECT_LANGUAGE_LABEL = 'Sprache wählen';

interface FloatingLanguageSwitcherProps {
  /** Resolved at SSR; avoids bundling page-data on the client. */
  selectLanguageLabel?: string;
}

export function FloatingLanguageSwitcher({
  selectLanguageLabel = DEFAULT_SELECT_LANGUAGE_LABEL,
}: FloatingLanguageSwitcherProps) {
  const [pathname, setPathname] = useState(typeof window !== 'undefined' ? window.location.pathname : '');
  const [isOpen, setIsOpen] = useState(false);
  const [currentLang, setCurrentLang] = useState<SupportedLanguage>(DEFAULT_LANGUAGE);

  useEffect(() => {
    setPathname(window.location.pathname);
    const pathLang = window.location.pathname.split('/')[1];
    if (SUPPORTED_LANGUAGES.includes(pathLang as SupportedLanguage)) {
      setCurrentLang(pathLang as SupportedLanguage);
    }
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('#floating-lang-container')) {
        setIsOpen(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const getPathWithoutLang = (currentPath: string) => {
    const segments = currentPath.split('/').filter(Boolean);
    if (SUPPORTED_LANGUAGES.includes(segments[0] as SupportedLanguage)) {
      const rest = segments.slice(1).join('/');
      return rest ? `/${rest}` : '/';
    }
    return currentPath || '/';
  };

  const switchLanguage = (newLang: SupportedLanguage) => {
    const currentPath =
      typeof window !== 'undefined' ? window.location.pathname : pathname;
    const pathWithoutLang = getPathWithoutLang(currentPath);
    let newPath: string;
    if (pathWithoutLang === '/' || pathWithoutLang === '') {
      newPath = `/${newLang}`;
    } else {
      const segments = pathWithoutLang.split('/').filter(Boolean);
      const [first, ...rest] = segments;
      const pageName = first ? resolvePageNameFromPathSegment(first) : undefined;
      const newFirst =
        pageName != null && first
          ? getLocalizedSlug(pageName, newLang)
          : first!;
      const tail = rest.length > 0 ? `/${rest.join('/')}` : '';
      newPath = `/${newLang}/${newFirst}${tail}`;
    }

    document.cookie = `preferred-language=${newLang};path=/;max-age=31536000`;
    window.location.href = `${window.location.origin}${newPath}`;
  };

  const currentConfig = getLanguageConfig(currentLang);

  return (
    <div
      id="floating-lang-container"
      className="fixed bottom-6 right-4 z-[9999] md:hidden"
    >
      {/* Dropdown - opens upward */}
      {isOpen && (
        <div className="absolute bottom-full right-0 mb-2 py-1 bg-white rounded-lg shadow-xl border border-gray-200 min-w-[150px] animate-in fade-in slide-in-from-bottom-2 duration-200">
          {SUPPORTED_LANGUAGES.map((lang) => {
            const config = getLanguageConfig(lang);
            const isActive = lang === currentLang;

            return (
              <button
                key={lang}
                onClick={() => {
                  if (!isActive) {
                    switchLanguage(lang);
                  }
                  setIsOpen(false);
                }}
                className={`
                  w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors cursor-pointer
                  ${isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-foreground hover:bg-gray-50'
                  }
                `}
              >
                <FlagIcon
                  lang={lang}
                  className="h-4 w-6 pointer-events-none"
                  title={config.nativeName}
                />
                <span>{config.nativeName}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Floating button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center w-12 h-12 bg-white rounded-full shadow-lg border border-gray-200 hover:shadow-xl transition-all duration-200 hover:scale-105 cursor-pointer"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={selectLanguageLabel}
      >
        <FlagIcon
          lang={currentLang}
          className="h-5 w-7 pointer-events-none"
          title={currentConfig.nativeName}
        />
      </button>
    </div>
  );
}
