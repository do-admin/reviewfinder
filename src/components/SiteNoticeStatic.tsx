import { Heading } from '@/components/Heading';

export interface SiteNoticeStaticProps {
  title: string;
  description: string;
  acceptAllLabel: string;
  acceptEssentialLabel: string;
  moreInfoLabel: string;
  privacyHref: string;
}

const buttonBase =
  'cursor-pointer inline-flex h-11 items-center justify-center whitespace-nowrap rounded-md px-8 text-sm font-medium ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.97] w-full sm:w-auto';

export function SiteNoticeStatic({
  title,
  description,
  acceptAllLabel,
  acceptEssentialLabel,
  moreInfoLabel,
  privacyHref,
}: SiteNoticeStaticProps) {
  return (
    <>
      <div
        data-site-notice
        className="fixed inset-0 z-[100] hidden items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      >
        <div
          data-site-notice-dialog
          role="dialog"
          aria-modal="true"
          aria-labelledby="site-notice-title"
          aria-describedby="site-notice-description"
          className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-2xl sm:p-8"
        >
          <Heading
            level={2}
            id="site-notice-title"
            className="mt-0 mb-3 text-2xl md:text-3xl"
          >
            {title}
          </Heading>

          <p
            id="site-notice-description"
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
            <button
              type="button"
              data-site-notice-essential
              className={`${buttonBase} border border-input bg-background hover:bg-accent hover:text-foreground`}
            >
              {acceptEssentialLabel}
            </button>
            <button
              type="button"
              data-site-notice-accept
              className={`${buttonBase} bg-primary text-primary-foreground hover:bg-primary/90`}
            >
              {acceptAllLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
