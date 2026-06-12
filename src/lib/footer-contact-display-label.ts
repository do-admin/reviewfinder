/**
 * Footer contact rows render a phone or mail icon next to `linkLabel`.
 * Generators and Excel sync often prefix labels with "Telefon:", "E-Mail:",
 * etc.; those duplicate the icon, so strip them for display (and persisted
 * output when normalized in scripts).
 */
export function footerContactLinkDisplayLabel(
  link: string,
  linkLabel: string | undefined
): string {
  if (typeof linkLabel !== 'string') return '';
  const label = linkLabel.trim();
  if (!label) return label;

  const href = link.trim();

  if (href.toLowerCase().startsWith('tel:')) {
    const stripped = label.replace(
      /^(telefon|tel\.?|mobil(e)?|handy|fax|phone)\s*:\s*/i,
      ''
    );
    return stripped.trim() || label;
  }

  if (href.toLowerCase().startsWith('mailto:')) {
    const stripped = label.replace(/^(e-?mail|email|mail)\s*:\s*/i, '');
    return stripped.trim() || label;
  }

  return label;
}
