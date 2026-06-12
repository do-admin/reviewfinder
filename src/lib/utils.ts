import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const createSlug = (text?: string | null) => {
  if (typeof text !== 'string') return '';

  return text
    .trim()
    .toLowerCase()
    .replace(/[äöüß]/g, (match) => {
      const replacements: { [key: string]: string } = {
        ä: 'ae',
        ö: 'oe',
        ü: 'ue',
        ß: 'ss',
      };
      return replacements[match] || match;
    })
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters except spaces and hyphens
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
};
