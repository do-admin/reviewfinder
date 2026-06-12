/**
 * Remove AI_PROTECTED_PATHS keys from a parsed AI response object.
 * Supports `[*]` as array wildcard — applies to every element in the array.
 *
 * Shared by scripts/06-generate-website.ts and scripts/clone-website.ts.
 */

import { AI_PROTECTED_PATHS } from './ai-protected-paths';

export function stripProtectedPaths(
  obj: Record<string, unknown>,
  paths: string[] = AI_PROTECTED_PATHS
): void {
  for (const pathPattern of paths) {
    deleteAtPath(obj, pathPattern.split('.'), 0);
  }
}

function deleteAtPath(node: unknown, segments: string[], idx: number): void {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (idx >= segments.length) return;

  const seg = segments[idx];
  const isLast = idx === segments.length - 1;

  const wildcardMatch = /^(\w+)\[\*\]$/.exec(seg);
  if (wildcardMatch) {
    const arrKey = wildcardMatch[1];
    const arr = (node as Record<string, unknown>)[arrKey];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (isLast) continue;
        deleteAtPath(item, segments, idx + 1);
      }
    }
    return;
  }

  if (isLast) {
    delete (node as Record<string, unknown>)[seg];
    return;
  }

  deleteAtPath((node as Record<string, unknown>)[seg], segments, idx + 1);
}
