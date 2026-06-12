import { createSlug } from '@/lib/utils';
import type { FaqXxlGroup } from '@/types/page';
import { Heading } from '@/components/Heading';

interface FaqXxlContentProps {
  groups: FaqXxlGroup[];
}

export function FaqXxlContent({ groups }: FaqXxlContentProps) {
  if (!groups || groups.length === 0) return null;

  return (
    <div className="space-y-12">
      {groups.map((group, groupIndex) => (
        <section key={groupIndex}>
          <Heading
            level={2}
            className="text-2xl md:text-3xl font-bold text-heading-foreground mb-6 font-heading"
          >
            {group.group_name}
          </Heading>
          <div className="space-y-3">
            {group.faqs.map((faq, faqIndex) => {
              const slug = createSlug(faq.question);
              return (
                <details
                  key={`${groupIndex}-${faqIndex}`}
                  className="group bg-muted rounded-lg border-none"
                  id={slug}
                  style={{ scrollMarginTop: '92px' }}
                >
                  <summary className="flex list-none items-center justify-between gap-4 font-body tracking-wide cursor-pointer px-6 py-4 hover:bg-muted/80 rounded-lg transition-colors text-left [&>span]:min-w-0 [&::-webkit-details-marker]:hidden">
                    <span className="text-left text-lg text-heading-foreground tracking-wide">
                      {faq.question}
                    </span>
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="24"
                      height="24"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4 shrink-0 transition-transform duration-200 group-open:rotate-180"
                      aria-hidden="true"
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </summary>
                  <div className="px-6 pb-4 text-muted-foreground leading-relaxed">
                    {faq.answer}
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
