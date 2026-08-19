export function compatibilityTitle(title: string): string {
  return title.startsWith('[Compatibility]') ? title : `[Compatibility] ${title}`;
}
