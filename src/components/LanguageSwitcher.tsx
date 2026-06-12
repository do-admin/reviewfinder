import { useState, useEffect } from 'react';
import {
  type SupportedLanguage,
  SUPPORTED_LANGUAGES,
  getLanguageConfig,
} from '@/lib/language';
import { resolvePageNameFromPathSegment, getLocalizedSlug } from '@/lib/route-slugs';
import { FlagIcon } from '@/components/FlagIcon';

const DEFAULT_SELECT_LANGUAGE_LABEL = 'Sprache wählen';

/** Trigger label render mode. Default `'flag-name'`. Dropdown rows always show flag + name. */
export type LanguageSwitcherDisplay = 'flag-name' | 'name' | 'code' | 'flag';

interface LanguageSwitcherProps {
  currentLang: SupportedLanguage;
  variant?: 'dropdown' | 'inline' | 'floating';
  className?: string;
  /** How to render the trigger button (default: 'flag-name' preserves prior behaviour). */
  display?: LanguageSwitcherDisplay;
  /** Resolved at SSR; avoids bundling page-data on the client. */
  selectLanguageLabel?: string;
}

function renderTriggerLabel(
  display: LanguageSwitcherDisplay,
  code: string,
  nativeName: string
) {
  const upperCode = code.toUpperCase();
  if (display === 'flag')
    return <FlagIcon lang={code} className="h-4 w-6" title={nativeName} />;
  if (display === 'code')
    return <span className="text-sm font-medium">{upperCode}</span>;
  if (display === 'name')
    return <span className="text-sm font-medium">{nativeName}</span>;
  // 'flag-name' (default): SVG flag on all screens, name hidden on smallest screens for dropdown variant
  return (
    <>
      <FlagIcon lang={code} className="h-4 w-6" title={nativeName} />
      <span className="hidden sm:inline">{nativeName}</span>
    </>
  );
}

export function LanguageSwitcher({
  currentLang,
  variant = 'dropdown',
  className = '',
  display = 'flag-name',
  selectLanguageLabel = DEFAULT_SELECT_LANGUAGE_LABEL,
}: LanguageSwitcherProps) {
  const [pathname, setPathname] = useState(
    typeof window !== 'undefined' ? window.location.pathname : ''
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);

  useEffect(() => {
    setPathname(window.location.pathname);
  }, []);

  useEffect(() => {
    if (variant !== 'dropdown') return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-language-switcher-dropdown]')) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [variant]);

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

  // Floating variant - Fixed position bottom-right (mobile only)
  if (variant === 'floating') {
    return (
      <div className={`fixed bottom-4 right-4 z-50 ${className}`}>
        <button
          onClick={() => {
            const dropdown = document.getElementById('floating-lang-dropdown');
            if (dropdown) {
              dropdown.classList.toggle('hidden');
            }
          }}
          className="cursor-pointer flex items-center justify-center gap-1 min-w-12 h-12 px-3 bg-white rounded-full shadow-lg border border-gray-200 hover:shadow-xl transition-shadow"
          aria-haspopup="listbox"
          aria-label={selectLanguageLabel}
        >
          {display === 'flag-name' || display === 'flag' ? (
            <FlagIcon
              lang={currentLang}
              className="h-5 w-7"
              title={currentConfig.nativeName}
            />
          ) : null}
          {display === 'code' && (
            <span className="text-sm font-medium">{currentLang.toUpperCase()}</span>
          )}
          {display === 'name' && (
            <span className="text-sm font-medium">{currentConfig.nativeName}</span>
          )}
        </button>
        <div
          id="floating-lang-dropdown"
          className="hidden absolute bottom-full right-0 mb-2 py-1 bg-white rounded-lg shadow-lg border border-gray-100 min-w-[140px]"
        >
          {SUPPORTED_LANGUAGES.map((lang) => {
            const config = getLanguageConfig(lang);
            const isActive = lang === currentLang;

            return (
              <button
                key={lang}
                onClick={() => {
                  if (!isActive) switchLanguage(lang);
                  const dropdown = document.getElementById(
                    'floating-lang-dropdown'
                  );
                  if (dropdown) dropdown.classList.add('hidden');
                }}
                className={`
                  w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors cursor-pointer
                  ${
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-gray-50'
                  }
                `}
                disabled={isActive}
              >
                <FlagIcon lang={lang} className="h-4 w-6" title={config.nativeName} />
                <span>{config.nativeName}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (variant === 'inline') {
    // Mobile: Show current language flag with dropdown on tap
    return (
      <div className={`relative ${className}`}>
        <button
          onClick={() => {
            const dropdown = document.getElementById('mobile-lang-dropdown');
            if (dropdown) {
              dropdown.classList.toggle('hidden');
            }
          }}
          className="flex items-center gap-1 px-2 py-1 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 transition-colors cursor-pointer"
          aria-haspopup="listbox"
          aria-label={selectLanguageLabel}
        >
          {renderTriggerLabel(
            display,
            currentLang,
            currentConfig.nativeName
          )}
          <svg
            className="w-3 h-3 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </button>
        <div
          id="mobile-lang-dropdown"
          className="hidden absolute top-full right-0 mt-1 py-1 bg-white rounded-lg shadow-lg border border-gray-100 z-50 min-w-[140px]"
        >
          {SUPPORTED_LANGUAGES.map((lang) => {
            const config = getLanguageConfig(lang);
            const isActive = lang === currentLang;

            return (
              <button
                key={lang}
                onClick={() => {
                  if (!isActive) switchLanguage(lang);
                  const dropdown = document.getElementById(
                    'mobile-lang-dropdown'
                  );
                  if (dropdown) dropdown.classList.add('hidden');
                }}
                className={`
                  w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors cursor-pointer
                  ${
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-gray-50'
                  }
                `}
                disabled={isActive}
              >
                <FlagIcon lang={lang} className="h-4 w-6" title={config.nativeName} />
                <span>{config.nativeName}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // Dropdown variant (default) - Desktop: click to open so the dropdown stays open until selection
  return (
    <div className={`relative`} data-language-switcher-dropdown>
      <button
        type="button"
        onClick={() => setDropdownOpen((open) => !open)}
        className={`flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:text-primary transition-colors rounded-lg hover:bg-gray-50 cursor-pointer ${className}`}
        aria-haspopup="listbox"
        aria-expanded={dropdownOpen}
        aria-label={selectLanguageLabel}
      >
        {renderTriggerLabel(
          display,
          currentLang,
          currentConfig.nativeName
        )}
        <svg
          className="w-3 h-3 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {dropdownOpen && (
        <div className="absolute top-full right-0 mt-1 py-1 bg-white rounded-lg shadow-lg border border-gray-100 z-50 min-w-[160px]">
          {SUPPORTED_LANGUAGES.map((lang) => {
            const config = getLanguageConfig(lang);
            const isActive = lang === currentLang;

            return (
              <button
                key={lang}
                type="button"
                onClick={() => {
                  if (!isActive) switchLanguage(lang);
                  setDropdownOpen(false);
                }}
                className={`
                  w-full flex items-center gap-3 px-4 py-2 text-sm text-left transition-colors cursor-pointer
                  ${
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-foreground hover:bg-gray-50 hover:text-primary'
                  }
                `}
                disabled={isActive}
                role="option"
                aria-selected={isActive}
              >
                <FlagIcon lang={lang} className="h-4 w-6" title={config.nativeName} />
                <span>{config.nativeName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
