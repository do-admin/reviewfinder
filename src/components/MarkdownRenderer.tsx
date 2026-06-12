import React from 'react';
import { ResponsiveImage } from '@/components/ResponsiveImage';

interface MarkdownRendererProps {
  content: string;
}

interface QuoteProps {
  children?: React.ReactNode;
  author?: string;
}

// Helper function to process links in text
const processLinksInText = (text: string): React.ReactNode[] => {
  const parts: React.ReactNode[] = [];
  let remainingText = text;

  while (remainingText.includes('[') && remainingText.includes('](')) {
    const linkMatch = remainingText.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (!linkMatch) break;

    const beforeLink = remainingText.substring(0, linkMatch.index);
    if (beforeLink) parts.push(beforeLink);

    const [fullMatch, linkText, url] = linkMatch;

    if (url.startsWith('http')) {
      parts.push(
        <a
          key={Math.random()}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary font-primary underline decoration-2 underline-offset-2 transition-colors hover:text-primary/80"
          data-hero-page-element-id="810473075533"
          herokit-id="d49cf24e-e0da-4f96-b86a-8fec570bbf88"
        >
          {linkText}
        </a>
      );
    } else {
      parts.push(
        <a
          key={Math.random()}
          href={url}
          className="text-primary font-primary underline decoration-2 underline-offset-2 transition-colors hover:text-primary/80"
          title={linkText}
          data-hero-page-element-id="810473075534"
          herokit-id="0152c80b-dbf2-42ec-9f12-50901fd4bb69"
        >
          {linkText}
        </a>
      );
    }

    remainingText = remainingText.substring(
      (linkMatch.index || 0) + fullMatch.length
    );
  }

  if (remainingText) parts.push(remainingText);
  return parts;
};

// Shared function to parse inline markdown
const parseInlineMarkdown = (text: string): React.ReactNode => {
  const parts: React.ReactNode[] = [];
  let remainingText = text;

  // Process bold and italic in order of appearance
  while (true) {
    const match = remainingText.match(
      /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^\n_]+)_)/
    );
    if (!match) break;

    const before = remainingText.substring(0, match.index);
    if (before) {
      // Process links in the before text
      const beforeParts = processLinksInText(before);
      parts.push(...beforeParts);
    }

    // match[2] is for **bold**, match[4] is for *italic*, match[6] is for _italic_
    if (match[2]) {
      parts.push(
        <span
          key={Math.random()}
          className="font-primary font-bold"
          data-hero-page-element-id="810473075531"
          herokit-id="31ec8ee4-4949-4f7c-8d59-ddbffa21260b"
        >
          {parseInlineMarkdown(match[2])}
        </span>
      );
    } else if (match[4] || match[6]) {
      parts.push(
        <em
          key={Math.random()}
          className="text-foreground font-primary italic"
          data-hero-page-element-id="810473075532"
          herokit-id="144c5ba0-f23a-4eb6-9654-62c3deb562a9"
        >
          {parseInlineMarkdown(match[4] || match[6])}
        </em>
      );
    }

    remainingText = remainingText.substring(
      (match.index || 0) + match[0].length
    );
  }

  // Process links in remaining text (after all bold/italic processing)
  const remainingParts = processLinksInText(remainingText);
  parts.push(...remainingParts);

  return parts.length > 0 ? parts : text;
};

const Quote: React.FC<QuoteProps> = ({ children, author }) => {
  return (
    <blockquote
      className="border-primary bg-accent/30 font-primary mx-auto my-4 max-w-3xl border-l-4 py-3 pl-4 text-center text-base italic sm:my-6 sm:py-4 sm:pl-6 md:my-8"
      data-hero-page-element-id="810473075535"
      herokit-id="7c8f6dcf-a3ce-45cd-afef-9c9de2ef49c9"
    >
      {parseInlineMarkdown(children as string)}
      {author && (
        <footer
          className="font-primary mt-3 text-base font-semibold not-italic sm:mt-4"
          data-hero-page-element-id="810473075536"
          herokit-id="a1c54fb8-dc7d-45bd-8090-183f5e4cd2e0"
        >
          — {parseInlineMarkdown(author)}
        </footer>
      )}
    </blockquote>
  );
};

interface SpecialBoxProps {
  children?: React.ReactNode;
  type: 'SUMMARY' | 'TIP' | 'FACT';
}

const SpecialBox: React.FC<SpecialBoxProps> = ({ children, type }) => {
  const baseClasses =
    'mx-auto my-4 max-w-3xl border-l-4 py-3 pl-4 text-base font-primary sm:my-6 sm:py-4 sm:pl-6 md:my-8';
  const typeClasses = {
    SUMMARY: 'border-blue-500 bg-blue-50/50',
    TIP: 'border-yellow-500 bg-yellow-50/50',
    FACT: 'border-green-500 bg-green-50/50',
  };

  return (
    <blockquote
      className={`${baseClasses} ${typeClasses[type]} text-foreground`}
      data-hero-page-element-id="810473075535"
      herokit-id="7c8f6dcf-a3ce-45cd-afef-9c9de2ef49c9"
    >
      {parseInlineMarkdown(children as string)}
    </blockquote>
  );
};

interface HighlightBoxWithImageAndCtaProps {
  title: string;
  description: string;
  features: string[];
  cta: string;
  ctaUrl: string;
  image: string;
  backgroundColor?: string;
  borderColor?: string;
}

const HighlightBoxWithImageAndCta: React.FC<
  HighlightBoxWithImageAndCtaProps
> = ({
  title,
  description,
  features,
  cta,
  ctaUrl,
  image,
  backgroundColor = '#78a09a',
  borderColor = '#78a09a',
}) => {
  const isExternalLink = ctaUrl.startsWith('http');

  return (
    <div
      style={{
        borderColor: borderColor,
        backgroundColor: backgroundColor,
        borderRadius: '1rem',
        padding: '1.5rem',
        margin: '1.5rem 0rem 1rem 0rem',
      }}
      data-hero-page-element-id="810473075562"
      herokit-id="highlight-box-with-image-and-cta"
    >
      <div
        style={{
          display: 'flex',
          gap: '1rem',
        }}
        className="flex-col sm:flex-row"
      >
        <div
          style={{
            flexGrow: 1,
            padding: '0.25rem',
          }}
        >
          <h3
            style={{
              color: '#ffffff',
              fontSize: '1.5rem',
              fontWeight: 500,
              marginBottom: '0.5rem',
            }}
            data-hero-page-element-id="810473075563"
          >
            {title}
          </h3>
          <p
            style={{
              color: '#ffffff',
              fontSize: '0.8rem',
              marginBottom: '1rem',
            }}
            data-hero-page-element-id="810473075564"
          >
            {parseInlineMarkdown(description)}
          </p>
          <ul
            style={{
              listStyle: 'none',
              padding: '0px',
              marginBottom: '1rem',
            }}
            data-hero-page-element-id="810473075565"
          >
            {features.map((feature, index) => (
              <li
                key={index}
                style={{
                  display: 'flex',
                  marginBottom: index < features.length - 1 ? '0.5rem' : '0',
                }}
                data-hero-page-element-id={`810473075566-${index}`}
              >
                <span
                  style={{
                    color: '#ffffff',
                    marginRight: '0.5rem',
                  }}
                  data-hero-page-element-id={`810473075567-${index}`}
                >
                  ✓
                </span>
                <p
                  style={{
                    color: '#ffffff',
                    fontSize: '0.8rem',
                    margin: 0,
                  }}
                  data-hero-page-element-id={`810473075568-${index}`}
                >
                  {parseInlineMarkdown(feature)}
                </p>
              </li>
            ))}
          </ul>
          {isExternalLink ? (
            <a
              href={ctaUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                backgroundColor: '#175857',
                padding: '0.5rem 0.75rem 0.5rem 1rem',
                borderRadius: '0.75rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                textDecoration: 'none',
                color: '#ffffff',
              }}
              data-hero-page-element-id="810473075569"
            >
              <span
                style={{
                  color: '#ffffff',
                }}
                data-hero-page-element-id="810473075570"
              >
                {cta}
              </span>
              <span
                style={{
                  color: '#ffffff',
                }}
                data-hero-page-element-id="810473075571"
              >
                →
              </span>
            </a>
          ) : (
            <a
              href={ctaUrl}
              style={{
                backgroundColor: '#175857',
                padding: '0.5rem 0.75rem 0.5rem 1rem',
                borderRadius: '0.75rem',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                textDecoration: 'none',
                color: '#ffffff',
              }}
              data-hero-page-element-id="810473075569"
            >
              <span
                style={{
                  color: '#ffffff',
                }}
                data-hero-page-element-id="810473075570"
              >
                {cta}
              </span>
              <span
                style={{
                  color: '#ffffff',
                }}
                data-hero-page-element-id="810473075571"
              >
                →
              </span>
            </a>
          )}
        </div>
        <div
          style={{
            backgroundColor: '#75958a',
            width: '100%',
            minWidth: '230px',
            padding: '1rem',
            borderRadius: '0.75rem',
          }}
          className="sm:w-[40%]"
          data-hero-page-element-id="810473075572"
        >
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: '100%',
              minHeight: '200px',
              overflow: 'hidden',
              borderRadius: '0.5rem',
            }}
          >
            <ResponsiveImage
              preset="content"
              src={image}
              alt={title}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                borderRadius: '0.5rem',
              }}
              data-hero-page-element-id="810473075573"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

interface FlowchartStep {
  number: string;
  text: string;
}

interface FlowchartProps {
  title: string;
  steps: FlowchartStep[];
}

const Flowchart: React.FC<FlowchartProps> = ({ title, steps }) => {
  return (
    <div
      className="mx-auto my-8 max-w-3xl rounded-xl border border-border bg-accent/10 p-6 shadow-sm sm:p-8"
      data-hero-page-element-id="810473075558"
      herokit-id="flowchart-component"
    >
      <h3
        className="mb-8 text-center text-xl font-bold tracking-wide uppercase text-heading-foreground"
        data-hero-page-element-id="810473075559"
      >
        {title}
      </h3>
      <div className="flex flex-col">
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;
          return (
            <div
              key={index}
              className={`relative flex gap-4 sm:gap-6 ${isLast ? '' : 'pb-8 sm:pb-12'}`}
            >
              {!isLast && (
                <div
                  className="absolute left-4 top-8 bottom-0 w-0.5 -translate-x-1/2 bg-border sm:left-5 sm:top-10"
                  aria-hidden="true"
                />
              )}

              <div
                className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold shadow-sm sm:h-10 sm:w-10 sm:text-base"
                data-hero-page-element-id={`810473075561-${index}`}
              >
                {step.number}
              </div>

              <div
                className="flex-1 rounded-lg border border-border bg-background p-4 shadow-sm transition-all hover:shadow-md sm:p-5"
                data-hero-page-element-id={`810473075560-${index}`}
              >
                <div className="text-foreground font-medium leading-relaxed">
                  {parseInlineMarkdown(step.text)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Function to parse table rows
const parseTableRow = (row: string): string[] => {
  return row
    .trim()
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
};

// Function to check if a line is a table separator
const isTableSeparator = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return false;

  const cells = trimmed
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
  return cells.every((cell) => /^[-:]+$/.test(cell));
};

// Generate a URL-friendly ID from heading text
const generateHeadingId = (text: string): string => {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .trim();
};

// Extract plain text from markdown for ID generation
// Must match the extractPlainText function in extract-headings.ts for consistent IDs
const extractPlainText = (text: string): string => {
  // Remove markdown formatting (bold, italic, links, inline code)
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
    .replace(/\*([^*]+)\*/g, '$1') // Remove italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links, keep text
    .replace(/`([^`]+)`/g, '$1') // Remove inline code
    .trim();
};

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
  // Simple markdown parser that handles the most common elements
  const parseMarkdown = (text: string): React.ReactNode[] => {
    const lines = text.split('\n');
    const elements: React.ReactNode[] = [];
    let currentList: string[] = [];
    let inList = false;
    let skipFirstHeading = true;
    let inTable = false;
    let tableRows: string[] = [];
    let tableHeaders: string[] = [];
    let inFlowchart = false;
    let flowchartTitle = '';
    let flowchartSteps: FlowchartStep[] = [];
    let currentStep: { number: string; text: string } | null = null;

    const processList = () => {
      if (currentList.length > 0) {
        elements.push(
          <ul
            key={Math.random()}
            className="font-primary mb-4 list-disc space-y-1.5 pl-4 text-base sm:mb-6 sm:space-y-2 sm:pl-6"
            data-hero-page-element-id="810473075537"
          >
            {currentList.map((item, index) => (
              <li
                key={index}
                className="text-foreground font-primary leading-relaxed"
                data-hero-page-element-id="810473075538"
                herokit-id="742e8e32-c8cd-4184-b7b1-382bc2f56a72"
              >
                {parseInlineMarkdown(item.trim().replace(/^[-*]\s*/, ''))}
              </li>
            ))}
          </ul>
        );
        currentList = [];
        inList = false;
      }
    };

    const processTable = () => {
      if (tableRows.length > 0 && tableHeaders.length > 0) {
        elements.push(
          <div
            key={Math.random()}
            className="-mx-2 my-4 overflow-x-auto sm:mx-0 sm:my-8"
            data-hero-page-element-id="810473075547"
          >
            <div className="inline-block min-w-full px-2 align-middle sm:px-0">
              <table
                className="border-border font-primary min-w-full border-collapse overflow-hidden rounded-lg border text-base"
                data-hero-page-element-id="810473075548"
              >
                <thead
                  className="bg-accent"
                  data-hero-page-element-id="810473075549"
                >
                  <tr data-hero-page-element-id="810473075550">
                    {tableHeaders.map((header, index) => (
                      <th
                        key={index}
                        className="border-border text-foreground font-primary border px-2 py-2 text-left text-base font-bold sm:px-4 sm:py-3"
                        data-hero-page-element-id={`810473075551-${index}`}
                        herokit-id="07ccc120-e771-42f2-a10a-616ee69eb702"
                      >
                        {parseInlineMarkdown(header)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody data-hero-page-element-id="810473075552">
                  {tableRows.map((row, rowIndex) => {
                    const cells = parseTableRow(row);
                    return (
                      <tr
                        key={rowIndex}
                        className={
                          rowIndex % 2 === 0 ? 'bg-background' : 'bg-muted/30'
                        }
                        data-hero-page-element-id={`810473075553-${rowIndex}`}
                      >
                        {cells.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            className="border-border text-foreground font-primary border px-2 py-2 text-base leading-relaxed sm:px-4 sm:py-3"
                            data-hero-page-element-id={`810473075554-${rowIndex}-${cellIndex}`}
                            herokit-id="fe731886-8936-4fab-bcea-8e61088f7ae8"
                          >
                            {parseInlineMarkdown(cell)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
        tableRows = [];
        tableHeaders = [];
        inTable = false;
      }
    };

    const processFlowchart = () => {
      if (flowchartSteps.length > 0 && flowchartTitle) {
        elements.push(
          <Flowchart
            key={Math.random()}
            title={flowchartTitle}
            steps={flowchartSteps}
          />
        );
        flowchartSteps = [];
        flowchartTitle = '';
        inFlowchart = false;
        currentStep = null;
      }
    };

    let paragraphLines: string[] = [];
    const processParagraph = () => {
      if (paragraphLines.length > 0) {
        elements.push(
          <p
            key={Math.random()}
            className="text-foreground font-primary mb-4 text-base leading-7 whitespace-pre-line sm:mb-6 md:mb-8"
            data-hero-page-element-id="810473075545"
            herokit-id="2be41a76-aa22-41fa-b4a2-9d52f09d6c66"
          >
            {parseInlineMarkdown(paragraphLines.join('\n'))}
          </p>
        );
        paragraphLines = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (!line) {
        processParagraph();
        processList();
        processTable();
        // Don't process flowchart on empty lines - allow empty lines within flowchart
        if (!inFlowchart) {
          processFlowchart();
        }
        continue;
      }

      // Check for [!PROCESS] marker - starts a process flowchart from blockquote lines
      if (line === '[!PROCESS]') {
        processParagraph();
        processList();
        processTable();
        processFlowchart();

        // Collect all subsequent blockquote lines as process steps
        const processSteps: FlowchartStep[] = [];
        let stepCounter = 0;
        i++; // Move to next line

        while (i < lines.length) {
          const processLine = lines[i].trim();

          // Empty line: end of block only after we've seen at least one step; otherwise skip (allow blank line after [!PROCESS])
          if (!processLine) {
            if (processSteps.length > 0) {
              break;
            }
            i++;
            continue;
          }

          // Check if it's a blockquote line
          if (processLine.startsWith('>')) {
            // Remove blockquote marker and trim, also remove trailing markdown line break (two spaces)
            const content = processLine
              .substring(1)
              .trim()
              .replace(/\s{2,}$/, '');

            // Skip arrow lines
            if (content === '**↓**' || content === '↓') {
              i++;
              continue;
            }

            // Extract step text from bold markers if present (handle trailing spaces)
            const boldMatch = content.match(/^\*\*(.+?)\*\*\s*$/);
            if (boldMatch) {
              const stepText = boldMatch[1].trim();
              // Check if it has a number prefix like "1. " or "2. "
              const numberedMatch = stepText.match(/^(\d+)\.\s*(.+)$/);
              if (numberedMatch) {
                processSteps.push({
                  number: numberedMatch[1],
                  text: numberedMatch[2].trim(),
                });
              } else {
                // No number, auto-increment
                stepCounter++;
                processSteps.push({
                  number: String(stepCounter),
                  text: stepText,
                });
              }
            } else if (
              content &&
              content !== '↓' &&
              !content.match(/^\*\*↓\*\*\s*$/)
            ) {
              // Plain text without bold (and not an arrow)
              stepCounter++;
              processSteps.push({
                number: String(stepCounter),
                text: content,
              });
            }
            i++;
          } else {
            // Not a blockquote line, stop processing
            i--; // Back up so main loop can process this line
            break;
          }
        }

        // Render the process flowchart
        if (processSteps.length > 0) {
          elements.push(
            <Flowchart
              key={Math.random()}
              title="Prozessübersicht"
              steps={processSteps}
            />
          );
        }
        continue;
      }

      // Check for arrow pattern - if we find **↓**, detect flowchart
      const arrowMatch = line.match(/^\*\*↓\*\*$/);
      if (arrowMatch && !inFlowchart) {
        // Look backwards to find the title (check previous 1-5 lines)
        // Take the most recent bold line as the title
        let foundTitle = '';

        for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
          const prevLine = lines[j].trim();
          if (prevLine) {
            // Check if it's a bold title (starts and ends with **)
            const titleMatch = prevLine.match(/^\*\*(.+?)\*\*$/);
            if (titleMatch) {
              // Skip arrows
              if (titleMatch[1] !== '↓') {
                // Use the most recent bold line as title
                foundTitle = titleMatch[1];
                break;
              }
            }
          }
        }

        processParagraph();
        processList();
        processTable();
        processFlowchart();
        inFlowchart = true;
        flowchartTitle = foundTitle || '';
        continue;
      }

      // Check for "[!SUMMARY]" flowchart start (special character marker)
      // Can be: ** [!SUMMARY] ** or **[!SUMMARY]** or ** [!SUMMARY] ** with optional text
      const summaryMatch = line.match(/^\*\*\s*\[!SUMMARY\]\s*\*\*$/i);
      if (summaryMatch) {
        processParagraph();
        processList();
        processTable();
        processFlowchart();
        inFlowchart = true;
        flowchartTitle = 'SUMMARY';
        continue;
      }

      // Check for "BEISPIEL" which ends the flowchart
      const beispielMatch = line.match(/^\*\*BEISPIEL\*\*$/i);
      if (beispielMatch) {
        if (inFlowchart && currentStep) {
          flowchartSteps.push(currentStep);
          currentStep = null;
        }
        processFlowchart();
        // Continue processing to render BEISPIEL as a heading
      }

      // Process flowchart steps
      if (inFlowchart) {
        // Check if line is an arrow (skip it)
        if (line.trim() === '**↓**' || line.trim() === '↓') {
          continue;
        }

        // Check if line is a numbered step (starts with **1., **2., etc.)
        const stepMatch = line.match(/^\*\*(\d+)\.\s+(.+?)\*\*$/);
        if (stepMatch) {
          // Save previous step if exists
          if (currentStep) {
            flowchartSteps.push(currentStep);
          }
          currentStep = {
            number: stepMatch[1],
            text: stepMatch[2],
          };
          continue;
        }

        // Check if line is a bold text (could be a step without number)
        const boldMatch = line.match(/^\*\*(.+?)\*\*$/);
        if (boldMatch && boldMatch[1] !== flowchartTitle) {
          // Save previous step if exists
          if (currentStep) {
            flowchartSteps.push(currentStep);
          }
          // Use auto-incrementing step number
          currentStep = {
            number: String(flowchartSteps.length + 1),
            text: boldMatch[1],
          };
          continue;
        }

        // If we hit a heading, end the flowchart first (heading will be processed below)
        if (line.startsWith('#')) {
          if (currentStep) {
            flowchartSteps.push(currentStep);
            currentStep = null;
          }
          processFlowchart();
          // Exit flowchart block to let heading be processed below
          // Don't continue - let the heading be processed in the heading section
        }
        // If we hit a non-flowchart line (not empty, not arrow, not step, not bold title, not heading), process the flowchart
        else if (line.trim() && !line.match(/^\*\*↓\*\*$/)) {
          if (currentStep) {
            flowchartSteps.push(currentStep);
            currentStep = null;
          }
          processFlowchart();
          continue; // Continue to skip this line (it's not a heading)
        }
      }

      // Check if this is a table row
      if (line.startsWith('|') && line.endsWith('|')) {
        processParagraph();
        processList();

        if (!inTable) {
          inTable = true;
        }

        if (isTableSeparator(line)) {
          // This is the separator row, skip it
          continue;
        }

        if (tableHeaders.length === 0) {
          // This is the header row
          tableHeaders = parseTableRow(line);
        } else {
          // This is a data row
          tableRows.push(line);
        }
        continue;
      }

      // If we were in a table but this line is not a table row, process the table
      if (inTable) {
        processParagraph();
        processTable();
      }

      // Headings - skip the first h1 heading
      if (line.startsWith('# ') && skipFirstHeading) {
        processParagraph();
        processList();
        processFlowchart();
        skipFirstHeading = false;
        continue; // Skip the main heading
      } else if (line.startsWith('###### ')) {
        processParagraph();
        processList();
        const headingText = line.substring(7).trim();
        const headingId = generateHeadingId(extractPlainText(headingText));
        elements.push(
          <h6
            key={Math.random()}
            id={headingId}
            className="font-heading mt-12 mb-6 text-base font-bold text-heading-foreground md:text-lg"
            data-hero-page-element-id="810473075544"
            herokit-id="ee451054-1d84-408f-9887-5c3ed7164b8b"
          >
            {parseInlineMarkdown(headingText)}
          </h6>
        );
      } else if (line.startsWith('##### ')) {
        processParagraph();
        processList();
        const headingText = line.substring(6).trim();
        const headingId = generateHeadingId(extractPlainText(headingText));
        elements.push(
          <h5
            key={Math.random()}
            id={headingId}
            className="font-heading mt-12 mb-6 text-lg font-bold text-heading-foreground md:text-xl"
            data-hero-page-element-id="810473075543"
            herokit-id="3a8c5606-c514-45b5-8c38-2b0b551a7d57"
          >
            {parseInlineMarkdown(headingText)}
          </h5>
        );
      } else if (line.startsWith('#### ')) {
        processParagraph();
        processList();
        const headingText = line.substring(5).trim();
        const headingId = generateHeadingId(extractPlainText(headingText));
        elements.push(
          <h4
            key={Math.random()}
            id={headingId}
            className="font-heading mt-12 mb-6 text-xl font-bold text-heading-foreground md:text-2xl"
            data-hero-page-element-id="810473075542"
            herokit-id="a7406803-5e34-44e2-98ce-cddd89bc59a1"
          >
            {parseInlineMarkdown(headingText)}
          </h4>
        );
      } else if (line.startsWith('### ')) {
        processParagraph();
        processList();
        const headingText = line.substring(4).trim();
        const headingId = generateHeadingId(extractPlainText(headingText));
        elements.push(
          <h3
            key={Math.random()}
            id={headingId}
            className="font-heading mt-6 mb-3 text-lg font-bold text-heading-foreground sm:mt-8 sm:mb-4 sm:text-xl md:mt-10 md:mb-5 md:text-2xl lg:mt-12 lg:mb-6 lg:text-3xl"
            data-hero-page-element-id="810473075541"
            herokit-id="953a2600-5a26-47fd-bb3a-8c41301cc2c3"
          >
            {parseInlineMarkdown(headingText)}
          </h3>
        );
      } else if (line.startsWith('## ')) {
        processParagraph();
        processList();
        const headingText = line.substring(3).trim();
        const headingId = generateHeadingId(extractPlainText(headingText));
        elements.push(
          <h2
            key={Math.random()}
            id={headingId}
            className="font-heading mt-8 mb-4 text-xl font-bold text-heading-foreground sm:mt-10 sm:mb-5 sm:text-2xl md:mt-12 md:mb-6 md:text-3xl lg:text-4xl"
            data-hero-page-element-id="810473075540"
            herokit-id="2e1b09f5-7b0c-403d-8a54-74b1fe105c49"
          >
            {parseInlineMarkdown(headingText)}
          </h2>
        );
      } else if (line.startsWith('# ')) {
        // Note: If we're in a flowchart, it should have been ended in the flowchart section above
        // But check again to be safe
        if (inFlowchart) {
          if (currentStep) {
            flowchartSteps.push(currentStep);
            currentStep = null;
          }
          processFlowchart();
        }
        processParagraph();
        processList();
        const headingText = line.substring(2).trim();
        const headingId = generateHeadingId(extractPlainText(headingText));
        elements.push(
          <h1
            key={Math.random()}
            id={headingId}
            className="font-heading mt-8 mb-4 text-xl font-bold text-heading-foreground sm:mt-10 sm:mb-5 sm:text-2xl md:mt-12 md:mb-6 md:text-3xl lg:text-4xl xl:text-5xl"
            data-hero-page-element-id="810473075539"
            herokit-id="a233ac07-1ce6-4ada-b6a8-6b6b0fb7bbc7"
          >
            {parseInlineMarkdown(headingText)}
          </h1>
        );
      }
      // Lists
      else if (line.match(/^[-*]\s+/)) {
        processParagraph();
        inList = true;
        currentList.push(line);
      }
      // Iframe detection (check before blockquotes to handle iframes in blockquotes)
      else if (line.includes('<iframe')) {
        processParagraph();
        processList();
        // Remove blockquote prefix if present
        const cleanLine = line.startsWith('> ') ? line.substring(2) : line;

        // Extract iframe attributes using regex
        const iframeMatch = cleanLine.match(/<iframe\s+([^>]+)><\/iframe>/);
        if (iframeMatch) {
          const attributesString = iframeMatch[1];
          const attributes: Record<string, string | boolean> = {};

          // Parse common iframe attributes
          const titleMatch = attributesString.match(/title="([^"]+)"/);
          if (titleMatch) attributes.title = titleMatch[1];

          const widthMatch = attributesString.match(/width="([^"]+)"/);
          if (widthMatch) attributes.width = widthMatch[1];

          const heightMatch = attributesString.match(/height="([^"]+)"/);
          if (heightMatch) attributes.height = heightMatch[1];

          const srcMatch = attributesString.match(/src="([^"]+)"/);
          if (srcMatch) attributes.src = srcMatch[1];

          const frameborderMatch = attributesString.match(
            /frameborder="([^"]+)"/
          );
          if (frameborderMatch) attributes.frameBorder = frameborderMatch[1];

          const allowMatch = attributesString.match(/allow="([^"]+)"/);
          if (allowMatch) attributes.allow = allowMatch[1];

          const referrerpolicyMatch = attributesString.match(
            /referrerpolicy="([^"]+)"/
          );
          if (referrerpolicyMatch)
            attributes.referrerPolicy = referrerpolicyMatch[1];

          const allowfullscreenMatch = attributesString.match(
            /allowfullscreen(?:="([^"]+)")?/
          );
          if (allowfullscreenMatch) {
            attributes.allowFullScreen =
              allowfullscreenMatch[1] === undefined ||
              allowfullscreenMatch[1] === '' ||
              allowfullscreenMatch[1] === 'true';
          }

          // Create iframe element with responsive wrapper
          const iframeHeight = attributes.height as string;
          const defaultHeight = '281';
          const heightValue = iframeHeight || defaultHeight;

          elements.push(
            <div
              key={Math.random()}
              className="my-4 w-full overflow-hidden rounded-lg sm:my-8"
              data-hero-page-element-id="810473075556"
            >
              <div
                className="relative w-full"
                style={{ paddingBottom: '56.25%' }}
              >
                <iframe
                  title={(attributes.title as string) || ''}
                  src={(attributes.src as string) || ''}
                  frameBorder={(attributes.frameBorder as string) || '0'}
                  allow={(attributes.allow as string) || ''}
                  referrerPolicy={
                    ((attributes.referrerPolicy as string) ||
                      'strict-origin-when-cross-origin') as React.HTMLAttributeReferrerPolicy
                  }
                  allowFullScreen={
                    (attributes.allowFullScreen as boolean) || false
                  }
                  className="absolute top-0 left-0 h-full w-full"
                  data-hero-page-element-id="810473075557"
                />
              </div>
            </div>
          );
          continue;
        }
      }
      // Blockquotes
      else if (line.startsWith('> ') && !line.includes('<iframe')) {
        processParagraph();
        processList();
        const quoteText = line.substring(2);

        // Check for special box markers: [!SUMMARY], [!TIP], [!FACT], [!HIGHLIGHT_BOX_WITH_IMAGE_AND_CTA]
        const specialBoxMatch = quoteText.match(/^\[!(\w+)\]\s*(.*)$/);
        if (specialBoxMatch) {
          const boxType = specialBoxMatch[1].toUpperCase() as
            | 'SUMMARY'
            | 'TIP'
            | 'FACT'
            | 'HIGHLIGHT_BOX_WITH_IMAGE_AND_CTA';
          let boxContent = specialBoxMatch[2] || '';

          // Collect additional lines for multi-line special boxes
          i++;
          while (i < lines.length) {
            const nextLine = lines[i];
            const trimmedNextLine = nextLine?.trim();

            // Handle empty lines (they can be part of blockquotes)
            if (!trimmedNextLine) {
              if (boxContent) {
                boxContent += '\n';
              }
              i++;
              continue;
            }

            // Check if line starts with "> " (may have leading whitespace)
            const trimmedStart = nextLine?.trimStart();
            if (trimmedStart?.startsWith('> ')) {
              // Extract content after "> " prefix
              const nextContent = trimmedStart.substring(2);
              // Stop if we hit another special box marker
              if (nextContent.trim().match(/^\[!\w+\]/)) {
                i--; // Back up one line
                break;
              }
              // Stop if we hit an author line
              if (nextContent.trim().startsWith('author ')) {
                i--; // Back up one line
                break;
              }
              boxContent += (boxContent ? '\n' : '') + nextContent;
              i++;
            } else {
              // Not a blockquote line, stop collecting
              i--; // Back up one line
              break;
            }
          }

          if (boxType === 'HIGHLIGHT_BOX_WITH_IMAGE_AND_CTA') {
            // Parse structured content for highlight box
            const highlightData: {
              title: string;
              description: string;
              features: string[];
              cta: string;
              ctaUrl: string;
              image: string;
              backgroundColor?: string;
              borderColor?: string;
            } = {
              title: '',
              description: '',
              features: [],
              cta: '',
              ctaUrl: '',
              image: '',
            };

            const contentLines = boxContent.split('\n');
            let currentSection:
              | 'title'
              | 'description'
              | 'features'
              | 'cta'
              | 'ctaUrl'
              | 'image'
              | 'backgroundColor'
              | 'borderColor'
              | null = null;

            for (const contentLine of contentLines) {
              const trimmed = contentLine.trim();
              if (!trimmed) continue;

              // Check for field markers
              if (trimmed.toLowerCase().startsWith('title:')) {
                highlightData.title = trimmed.substring(6).trim();
                currentSection = null;
              } else if (trimmed.toLowerCase().startsWith('description:')) {
                highlightData.description = trimmed.substring(12).trim();
                currentSection = null;
              } else if (trimmed.toLowerCase().startsWith('features:')) {
                currentSection = 'features';
              } else if (trimmed.toLowerCase().startsWith('cta:')) {
                highlightData.cta = trimmed.substring(4).trim();
                currentSection = null;
              } else if (
                trimmed.toLowerCase().startsWith('ctaurl:') ||
                trimmed.toLowerCase().startsWith('cta-url:')
              ) {
                highlightData.ctaUrl = trimmed
                  .substring(trimmed.indexOf(':') + 1)
                  .trim();
                currentSection = null;
              } else if (trimmed.toLowerCase().startsWith('image:')) {
                highlightData.image = trimmed.substring(6).trim();
                currentSection = null;
              } else if (
                trimmed.toLowerCase().startsWith('backgroundcolor:') ||
                trimmed.toLowerCase().startsWith('background-color:')
              ) {
                highlightData.backgroundColor = trimmed
                  .substring(trimmed.indexOf(':') + 1)
                  .trim();
                currentSection = null;
              } else if (
                trimmed.toLowerCase().startsWith('bordercolor:') ||
                trimmed.toLowerCase().startsWith('border-color:')
              ) {
                highlightData.borderColor = trimmed
                  .substring(trimmed.indexOf(':') + 1)
                  .trim();
                currentSection = null;
              } else if (currentSection === 'features') {
                // Remove list marker if present
                const featureText = trimmed.replace(/^[-*]\s*/, '').trim();
                if (featureText) {
                  highlightData.features.push(featureText);
                }
              } else if (!currentSection && trimmed) {
                // If no section is active and we have content, it might be a continuation
                // Try to infer: if it starts with - or *, it's a feature
                if (trimmed.match(/^[-*]\s+/)) {
                  highlightData.features.push(
                    trimmed.replace(/^[-*]\s*/, '').trim()
                  );
                }
              }
            }

            // Validate required fields
            if (
              highlightData.title &&
              highlightData.description &&
              highlightData.cta &&
              highlightData.ctaUrl &&
              highlightData.image
            ) {
              elements.push(
                <HighlightBoxWithImageAndCta
                  key={Math.random()}
                  title={highlightData.title}
                  description={highlightData.description}
                  features={highlightData.features}
                  cta={highlightData.cta}
                  ctaUrl={highlightData.ctaUrl}
                  image={highlightData.image}
                  backgroundColor={highlightData.backgroundColor}
                  borderColor={highlightData.borderColor}
                />
              );
            } else {
              // Invalid highlight box, render as regular quote
              elements.push(
                <Quote
                  key={Math.random()}
                  herokit-id="7ce378d4-72e2-43ce-bc1b-ad448438eb2e"
                >
                  {quoteText}
                </Quote>
              );
            }
          } else if (
            boxType === 'SUMMARY' ||
            boxType === 'TIP' ||
            boxType === 'FACT'
          ) {
            elements.push(
              <SpecialBox key={Math.random()} type={boxType}>
                {boxContent}
              </SpecialBox>
            );
          } else {
            // Unknown special box type, render as regular quote
            elements.push(
              <Quote
                key={Math.random()}
                herokit-id="7ce378d4-72e2-43ce-bc1b-ad448438eb2e"
              >
                {quoteText}
              </Quote>
            );
          }
        } else {
          // Regular blockquote - check if the next line is an author line
          const nextLine = lines[i + 1]?.trim();
          if (nextLine && nextLine.startsWith('> author ')) {
            const author = nextLine.substring(9);
            elements.push(
              <Quote
                key={Math.random()}
                author={author}
                herokit-id="aae4bc7e-3275-437b-8cda-1950ab2c3329"
              >
                {quoteText}
              </Quote>
            );
            i++; // Skip the author line since we used it
          } else {
            elements.push(
              <Quote
                key={Math.random()}
                herokit-id="7ce378d4-72e2-43ce-bc1b-ad448438eb2e"
              >
                {quoteText}
              </Quote>
            );
          }
        }
      }
      // Horizontal rules
      else if (line.match(/^[-*_]{3,}$/)) {
        processParagraph();
        processList();
        elements.push(
          <hr
            key={Math.random()}
            className="border-border my-4 border-t sm:my-6 md:my-8"
          />
        );
      }
      // Image syntax: [IMAGE: filename.webp]
      else if (line.match(/^\[IMAGE:\s*(.+?)\]$/)) {
        processParagraph();
        processList();
        const imageMatch = line.match(/^\[IMAGE:\s*(.+?)\]$/);
        if (imageMatch) {
          const filename = imageMatch[1].trim();
          const imagePath = `/assets/articleImages/${filename}`;
          const altText = filename.replace(/\.[^.]+$/, '').replace(/-/g, ' ');
          elements.push(
            <figure
              key={Math.random()}
              className="my-6 sm:my-8 md:my-10"
              data-hero-page-element-id="810473075574"
            >
              <ResponsiveImage
                preset="content"
                src={imagePath}
                alt={altText}
                className="w-full rounded-lg"
                loading="lazy"
                data-hero-page-element-id="810473075575"
              />
            </figure>
          );
        }
      }
      // Regular paragraphs (accumulate consecutive non-empty lines into one paragraph)
      else {
        paragraphLines.push(line);
      }
    }

    processParagraph();
    processList();
    processTable();
    processFlowchart();
    return elements;
  };

  const elements = parseMarkdown(content);

  return (
    <div
      className="prose prose-lg max-w-none"
      data-hero-page-element-id="810473075546"
      herokit-id="5d6e68a6-7665-43bf-ba20-02605e4f555b"
    >
      {elements}
    </div>
  );
};

export default MarkdownRenderer;
