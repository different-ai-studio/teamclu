/** Public app logo paths from `packages/app/public/` (respects Vite `base`). */
export function appLogoUrl(fileName: 'logo.png' | 'logo-64.png' = 'logo.png'): string {
  const base = import.meta.env.BASE_URL ?? '/'
  return `${base}${fileName}`
}
