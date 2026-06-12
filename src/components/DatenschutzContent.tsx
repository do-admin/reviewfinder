import ImpressumContent from '@/components/ImpressumContent';

interface DatenschutzContentProps {
  /** Structured blocks from shared.datenschutz in websites.json */
  blocks?: import('@/types/page').LegalContentBlock[];
}

export default function DatenschutzContent({
  blocks,
}: DatenschutzContentProps) {
  return <ImpressumContent blocks={blocks} />;
}
