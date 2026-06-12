import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Heading } from './Heading';

declare global {
  interface Window {
    gtag: (...args: any[]) => void;
    dataLayer: any[];
  }
}

export interface SiteNoticeProps {
  title: string;
  description: string;
  acceptAllLabel: string;
  acceptEssentialLabel: string;
  moreInfoLabel: string;
  privacyHref: string;
}

const CONSENT_STORAGE_KEY = 'cookieConsent';
const TITLE_ID = 'site-notice-title';
const DESCRIPTION_ID = 'site-notice-description';

// GDPR: legally required pages (Datenschutz, Impressum) must remain accessible
// without prior consent — otherwise consent is not "freely given" (Art. 4(11),
// Art. 7(4) GDPR). The notice is suppressed on these routes; the user makes
// their choice when navigating back to any other page.
const CONSENT_EXEMPT_PATH = /\/(datenschutz|impressum)\/?$/i;

export const SiteNotice = ({
  title,
  description,
  acceptAllLabel,
  acceptEssentialLabel,
  moreInfoLabel,
  privacyHref,
}: SiteNoticeProps) => {
  const [showNotice, setShowNotice] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const acceptButtonRef = useRef<HTMLButtonElement>(null);

  const updateConsent = useCallback((granted: boolean) => {
    if (typeof window === 'undefined' || typeof window.gtag !== 'function') {
      return;
    }
    const value = granted ? 'granted' : 'denied';
    window.gtag('consent', 'update', {
      analytics_storage: value,
      ad_storage: value,
      ad_user_data: value,
      ad_personalization: value,
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const cookieConsent = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (cookieConsent !== null) {
      updateConsent(cookieConsent === 'accepted');
      return;
    }
    if (CONSENT_EXEMPT_PATH.test(window.location.pathname)) return;
    setShowNotice(true);
  }, [updateConsent]);

  // While the dialog is open, lock body scroll and trap keyboard focus so
  // the user cannot interact with the rest of the page until a choice is made.
  useEffect(() => {
    if (!showNotice || typeof document === 'undefined') return;

    const { body, documentElement } = document;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    acceptButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showNotice]);

  const persistChoice = (choice: 'accepted' | 'declined') => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(CONSENT_STORAGE_KEY, choice);
      } catch {
        /* localStorage may be unavailable (private mode, quota); ignore. */
      }
    }
  };

  const handleAcceptAll = () => {
    persistChoice('accepted');
    updateConsent(true);
    setShowNotice(false);
  };

  const handleRejectNonEssential = () => {
    persistChoice('declined');
    updateConsent(false);
    setShowNotice(false);
  };

  if (!showNotice) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={DESCRIPTION_ID}
        className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-2xl sm:p-8"
      >
        <Heading
          level={2}
          id={TITLE_ID}
          className="mt-0 mb-3 text-2xl md:text-3xl"
        >
          {title}
        </Heading>

        <p
          id={DESCRIPTION_ID}
          className="mb-4 text-base leading-relaxed text-foreground"
        >
          {description}
        </p>

        <a
          href={privacyHref}
          className="mb-6 inline-block text-sm font-medium text-primary underline underline-offset-4 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {moreInfoLabel}
        </a>

        <div className="mt-2 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
          <Button
            type="button"
            onClick={handleRejectNonEssential}
            variant="outline"
            size="lg"
            className="w-full sm:w-auto"
          >
            {acceptEssentialLabel}
          </Button>
          <Button
            type="button"
            ref={acceptButtonRef}
            onClick={handleAcceptAll}
            size="lg"
            className="w-full sm:w-auto"
          >
            {acceptAllLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};
