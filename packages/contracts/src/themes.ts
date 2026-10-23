// Menu themes: how a restaurant's public menu, cart and tracking pages look.
// Free of zod, so the website can import it. Ideas for more themes:
// bilhanah-client-FE/docs/THEMES.md.

export const MENU_THEMES = ['classic', 'arabesque'] as const;
export type MenuTheme = (typeof MENU_THEMES)[number];

export const DEFAULT_MENU_THEME: MenuTheme = 'classic';

export const MENU_THEME_INFO: Record<MenuTheme, { name: { ar: string; en: string }; description: { ar: string; en: string } }> = {
  classic: {
    name: { ar: 'كلاسيك', en: 'Classic' },
    description: { ar: 'هادي ونضيف، يناسب أي مطعم.', en: 'Warm and clean; suits any restaurant.' },
  },
  arabesque: {
    name: { ar: 'أرابيسك', en: 'Arabesque' },
    description: { ar: 'نقوش هندسية وذهبي على أخضر غامق، وخط نسخ أنيق.', en: 'Geometric patterns, gold on deep green, an elegant Naskh script.' },
  },
};

export function isMenuTheme(value: unknown): value is MenuTheme {
  return typeof value === 'string' && (MENU_THEMES as readonly string[]).includes(value);
}
