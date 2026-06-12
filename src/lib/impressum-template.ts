import type {
  LegalContentBlock,
  LegalInlinePart,
  ResolvedPageData,
} from '@/types/page';
import impressumContent from '../data/_template/legal/impressum-content.json';
import impressumContentEn from '../data/_template/legal/impressum-content-en.json';
import { formatPhoneForDisplay } from '@/lib/business';
import type { SupportedLanguage } from '@/lib/language';

function getImpressumContent(language?: SupportedLanguage) {
  return language === 'en' ? impressumContentEn : impressumContent;
}

type ImpressumOptionalGroup = {
  showIfNonEmpty?: string;
  showIfAnyNonEmpty?: string[];
  blocks: unknown[];
};

type ClientVariant = {
  pageTitle: string;
  blocks: unknown[];
  optionalGroups?: ImpressumOptionalGroup[];
};

function telHref(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, '');
  return cleaned ? `tel:${cleaned}` : '';
}

function interpolateString(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_m, key: string) => vars[key] ?? ''
  );
}

function buildClientImpressumVars(
  business: ResolvedPageData['business']
): Record<string, string> {
  const a = business.legalAddress;
  return {
    firmenname: (
      business.legalName ||
      business.name ||
      business.brandName ||
      ''
    ).trim(),
    strasse: (a?.street || '').trim(),
    plz: (a?.postalCode || '').trim(),
    ort: (a?.city || '').trim(),
    registergericht: (business.registergericht || '').trim(),
    hrbNummer: (business.hrbNummer || '').trim(),
    ustId: (business.ustId || '').trim(),
    vertreter: (business.vertreter || '').trim(),
    telefon: formatPhoneForDisplay(
      (business.phoneLegal ?? business.phone) || ''
    ).trim(),
    email: ((business.legalEmail ?? business.email) || '').trim(),
  };
}

function shouldIncludeOptionalGroup(
  group: ImpressumOptionalGroup,
  vars: Record<string, string>
): boolean {
  if (group.showIfNonEmpty) {
    return Boolean(vars[group.showIfNonEmpty]?.trim());
  }
  if (group.showIfAnyNonEmpty?.length) {
    return group.showIfAnyNonEmpty.some((k) => Boolean(vars[k]?.trim()));
  }
  return true;
}

function interpolateInlinePart(
  part: LegalInlinePart,
  vars: Record<string, string>
): LegalInlinePart {
  switch (part.type) {
    case 'text':
      return {
        ...part,
        value: interpolateString(part.value, vars),
      };
    case 'br':
      return part;
    case 'em':
      return {
        ...part,
        value: interpolateString(part.value, vars),
      };
    case 'strong':
      if (part.parts?.length) {
        return {
          ...part,
          parts: part.parts.map((p) => interpolateInlinePart(p, vars)),
        };
      }
      return {
        ...part,
        value:
          part.value != null ? interpolateString(part.value, vars) : part.value,
      };
    case 'link':
      return {
        ...part,
        href: interpolateString(part.href, vars),
        value: interpolateString(part.value, vars),
      };
    default:
      return part;
  }
}

function interpolateBlock(
  raw: unknown,
  vars: Record<string, string>
): LegalContentBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const type = b.type;
  if (type === 'heading') {
    const text =
      typeof b.text === 'string' ? interpolateString(b.text, vars) : '';
    return {
      type: 'heading',
      level: (b.level as 1 | 2 | 3) ?? 2,
      text,
    };
  }
  if (type === 'paragraph') {
    if (Array.isArray(b.parts)) {
      return {
        type: 'paragraph',
        parts: (b.parts as LegalInlinePart[]).map((p) =>
          interpolateInlinePart(p, vars)
        ),
      };
    }
    if (typeof b.text === 'string') {
      return {
        type: 'paragraph',
        text: interpolateString(b.text, vars),
      };
    }
    return { type: 'paragraph', parts: [] };
  }
  if (type === 'image') {
    return JSON.parse(JSON.stringify(raw)) as LegalContentBlock;
  }
  return null;
}

function appendClientKontaktSection(
  blocks: LegalContentBlock[],
  vars: Record<string, string>,
  language?: SupportedLanguage
): void {
  const phone = vars.telefon;
  const email = vars.email;
  if (!phone && !email) return;

  const contactLabel = language === 'en' ? 'Contact' : 'Kontakt';
  const phoneLabel = language === 'en' ? 'Phone: ' : 'Telefon: ';
  const emailLabel = language === 'en' ? 'Email: ' : 'E-Mail: ';

  blocks.push({ type: 'heading', level: 2, text: contactLabel });
  const parts: LegalInlinePart[] = [];
  if (phone) {
    const href = telHref(phone);
    parts.push({ type: 'text', value: phoneLabel });
    if (href) {
      parts.push({ type: 'link', href, value: phone });
    } else {
      parts.push({ type: 'text', value: phone });
    }
  }
  if (email) {
    if (parts.length) parts.push({ type: 'br' });
    parts.push({ type: 'text', value: emailLabel });
    parts.push({
      type: 'link',
      href: `mailto:${email}`,
      value: email,
    });
  }
  if (parts.length) {
    blocks.push({ type: 'paragraph', parts });
  }
}

export function buildClientImpressumBlocks(
  pageData: ResolvedPageData,
  language?: SupportedLanguage
): LegalContentBlock[] {
  const content = getImpressumContent(language);
  const client = content.variants.client as ClientVariant;
  const vars = buildClientImpressumVars(pageData.business);
  const blocks: LegalContentBlock[] = [];

  for (const raw of client.blocks ?? []) {
    const block = interpolateBlock(raw, vars);
    if (block) blocks.push(block);
  }

  for (const group of client.optionalGroups ?? []) {
    if (!shouldIncludeOptionalGroup(group, vars)) continue;
    for (const raw of group.blocks ?? []) {
      const block = interpolateBlock(raw, vars);
      if (block) blocks.push(block);
    }
  }

  appendClientKontaktSection(blocks, vars, language);
  return blocks;
}

export function getClientImpressumPageTitle(language?: SupportedLanguage): string {
  const content = getImpressumContent(language);
  const client = content.variants.client as ClientVariant;
  return client.pageTitle || 'Impressum';
}

export function buildHeroPagesImpressumBlocks(language?: SupportedLanguage): LegalContentBlock[] {
  const content = getImpressumContent(language);
  const raw = content.variants.heroPages.blocks;
  return JSON.parse(JSON.stringify(raw)) as LegalContentBlock[];
}

export function getHeroPagesImpressumPageTitle(language?: SupportedLanguage): string {
  const content = getImpressumContent(language);
  return content.variants.heroPages.pageTitle || 'Impressum';
}
