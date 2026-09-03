/**
 * The kinds of app the platform can build and deploy.
 *
 * All three deploy through one pipeline — `pnpm build` produces
 * `.output/server/index.mjs` listening on `$PORT` — so the type only decides
 * which starter template the daemon writes and whether the deploy provisions a
 * Postgres schema. See docs/specs/2026-07-28-app-types-design.md.
 */
export type AppTypeId = 'static_web' | 'slides' | 'data_app' | 'imported'

/** Stored on apps created before types existed; means `data_app`. */
export const LEGACY_DATA_APP_TYPE = 'fullstack_tanstack_postgres'

interface AppTypeMeta {
  id: AppTypeId
  /** i18n key + Chinese fallback, matching how the Apps UI names things. */
  labelKey: string
  label: string
  descriptionKey: string
  description: string
  /** Only data apps get a per-app Postgres schema. */
  needsDatabase: boolean
}

export const APP_TYPES: AppTypeMeta[] = [
  {
    id: 'static_web',
    labelKey: 'apps.typeStaticWeb',
    label: '静态网页',
    descriptionKey: 'apps.typeStaticWebDesc',
    description: '一个网站。HTML、样式、图片。',
    needsDatabase: false,
  },
  {
    id: 'slides',
    labelKey: 'apps.typeSlides',
    label: '演示材料',
    descriptionKey: 'apps.typeSlidesDesc',
    description: '一套幻灯片，可以直接放映和分享。',
    needsDatabase: false,
  },
  {
    id: 'data_app',
    labelKey: 'apps.typeDataApp',
    label: '数据操作',
    descriptionKey: 'apps.typeDataAppDesc',
    description: '能存数据、能查能改的应用，自带一个数据库。',
    needsDatabase: true,
  },
]

/**
 * An app whose code came from somewhere else — a local git checkout the user
 * pointed us at, or a repo cloned from a URL they supplied.
 *
 * Not in [[APP_TYPES]] on purpose: nobody picks this in the create dialog, it
 * is what the import paths store because `apps.type` is NOT NULL and every
 * unrecognized value means `data_app` — which would have made every imported
 * repo try to provision a Postgres schema on its first deploy.
 */
export const IMPORTED_APP_TYPE: AppTypeMeta = {
  id: 'imported',
  labelKey: 'apps.typeImported',
  label: '导入的仓库',
  descriptionKey: 'apps.typeImportedDesc',
  description: '代码来自本地目录或已有的 git 仓库。',
  needsDatabase: false,
}

export const DEFAULT_APP_TYPE: AppTypeId = 'static_web'

/**
 * Resolve a stored `type` value to a known type.
 *
 * Anything unrecognized — including the legacy id and the empty string — is a
 * data app, which is what every app created before the split actually is.
 */
export function resolveAppType(raw: string | null | undefined): AppTypeMeta {
  const id = (raw ?? '').trim()
  if (id === IMPORTED_APP_TYPE.id) return IMPORTED_APP_TYPE
  return APP_TYPES.find((t) => t.id === id) ?? APP_TYPES[APP_TYPES.length - 1]
}
