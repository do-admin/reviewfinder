import { useState, useEffect } from 'react';
import { X, Bot } from 'lucide-react';
import type { ResolvedPageData } from '@/types/page';
import { DEFAULT_LANGUAGE, type SupportedLanguage, getLanguageConfig } from '@/lib/language';
import { getUiStrings, t } from '@/lib/page-data';

interface AITranslationDisclaimerProps {
  language: SupportedLanguage;
  pageData?: ResolvedPageData;
}

const DISCLAIMER_DISMISSED_KEY = 'ai-translation-disclaimer-dismissed';

// Default disclaimer texts for languages without translations
const DEFAULT_DISCLAIMERS: Record<string, string> = {
  en: 'This page has been automatically translated using AI. The original content is in German.',
  sq: 'Kjo faqe është përkthyer automatikisht duke përdorur AI. Përmbajtja origjinale është në gjermanisht.',
  uk: 'Цю сторінку було автоматично перекладено за допомогою ШІ. Оригінальний вміст німецькою мовою.',
  tr: 'Bu sayfa yapay zeka kullanılarak otomatik olarak çevrilmiştir. Orijinal içerik Almanca\'dır.',
  ar: 'تمت ترجمة هذه الصفحة تلقائيًا باستخدام الذكاء الاصطناعي. المحتوى الأصلي باللغة الألمانية.',
  hi: 'इस पृष्ठ का AI का उपयोग करके स्वचालित रूप से अनुवाद किया गया है। मूल सामग्री जर्मन में है।',
};

export function AITranslationDisclaimer({ language, pageData }: AITranslationDisclaimerProps) {
  const [isDismissed, setIsDismissed] = useState(true); // Start hidden to prevent flash
  const [isVisible, setIsVisible] = useState(false);
  const [isMobileExpanded, setIsMobileExpanded] = useState(false);

  useEffect(() => {
    // Check session storage on mount
    const dismissed = sessionStorage.getItem(DISCLAIMER_DISMISSED_KEY);
    if (!dismissed) {
      setIsDismissed(false);
      // Small delay for smooth entrance
      setTimeout(() => setIsVisible(true), 100);
    }
  }, []);

  // Close mobile popup when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('#ai-disclaimer-container')) {
        setIsMobileExpanded(false);
      }
    };

    if (isMobileExpanded) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [isMobileExpanded]);

  // Don't show for default language (German)
  if (language === DEFAULT_LANGUAGE) {
    return null;
  }

  // Don't render if dismissed
  if (isDismissed) {
    return null;
  }

  const handleDismiss = () => {
    setIsVisible(false);
    setIsMobileExpanded(false);
    // Wait for animation before removing from DOM
    setTimeout(() => {
      setIsDismissed(true);
      sessionStorage.setItem(DISCLAIMER_DISMISSED_KEY, 'true');
    }, 300);
  };

  const languageConfig = getLanguageConfig(language);
  const isRTL = languageConfig.direction === 'rtl';
  const uiStrings = getUiStrings(pageData ?? language) || {};

  // Get disclaimer text - using the translation key or fallback
  const disclaimerText = uiStrings['disclaimer.aiTranslation'] ||
    DEFAULT_DISCLAIMERS[language] ||
    'This page has been automatically translated using AI. The original content is in German.';

  return (
    <>
      {/* Desktop version - full banner */}
      <div
        className={`fixed bottom-4 z-50 max-w-sm transition-all duration-300 hidden md:block ${
          isRTL ? 'left-4' : 'right-4'
        } ${
          isVisible
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 translate-y-4'
        }`}
        role="alert"
        aria-live="polite"
      >
        <div className="bg-amber-50 border border-amber-200 rounded-lg shadow-lg p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0">
              <Bot className="h-5 w-5 text-amber-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-amber-800">
                {disclaimerText}
              </p>
            </div>
            <button
              onClick={handleDismiss}
              className="flex-shrink-0 p-1 rounded-full hover:bg-amber-100 transition-colors cursor-pointer"
              aria-label={t('disclaimer.dismissAria', pageData ?? language)}
            >
              <X className="h-4 w-4 text-amber-600" />
            </button>
          </div>
        </div>
      </div>

      {/* Mobile version - circular button with expandable popup */}
      <div
        id="ai-disclaimer-container"
        className={`fixed bottom-20 z-50 md:hidden transition-all duration-300 ${
          isRTL ? 'left-4' : 'right-4'
        } ${
          isVisible
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 translate-y-4'
        }`}
      >
        {/* Popup message - opens upward */}
        {isMobileExpanded && (
          <div
            className={`absolute bottom-full mb-2 w-64 bg-amber-50 border border-amber-200 rounded-lg shadow-xl p-3 animate-in fade-in slide-in-from-bottom-2 duration-200 ${
              isRTL ? 'left-0' : 'right-0'
            }`}
            role="alert"
          >
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-amber-800">
                  {disclaimerText}
                </p>
              </div>
              <button
                onClick={handleDismiss}
                className="flex-shrink-0 p-1 rounded-full hover:bg-amber-100 transition-colors cursor-pointer"
                aria-label={t('disclaimer.dismissAria', pageData ?? language)}
              >
                <X className="h-4 w-4 text-amber-600" />
              </button>
            </div>
          </div>
        )}

        {/* Circular button */}
        <button
          onClick={() => setIsMobileExpanded(!isMobileExpanded)}
          className="flex items-center justify-center w-12 h-12 bg-amber-50 border border-amber-200 rounded-full shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105 cursor-pointer"
          aria-label={t('disclaimer.infoAria', pageData ?? language)}
          aria-expanded={isMobileExpanded}
        >
          <Bot className="h-6 w-6 text-amber-600" />
        </button>
      </div>
    </>
  );
}
