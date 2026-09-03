import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Loader2, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { getBackend } from '@/lib/backend'
import { formatAppDataCell, cellEditValue, parseCellInput } from '@/lib/apps/app-data-cell'
import { appDataRowKey } from '@/lib/apps/app-data-row-key'
import type { AppDataRowsPage, AppDataTable, AppRow } from '@/lib/backend/types'

interface AppDataBrowserProps {
  app: AppRow
  tables: AppDataTable[]
  /** From the control panel: `admin` may edit and delete, `prompt` may not. */
  canEdit: boolean
  initialTable?: string | null
}

type RowEdit = { rowKey: string; draft: Record<string, string> }

/**
 * Full-width browser for one app's live Postgres tables.
 *
 * Rendered in a main-column native tab, not in a modal — the control panel is
 * too narrow for a row of database columns.
 */
export function AppDataBrowser({ app, tables, canEdit, initialTable }: AppDataBrowserProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = React.useState<string | null>(
    initialTable ?? tables[0]?.name ?? null,
  )
  const [page, setPage] = React.useState<AppDataRowsPage | null>(null)
  const [rows, setRows] = React.useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [edit, setEdit] = React.useState<RowEdit | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState(false)

  React.useEffect(() => {
    setSelected(initialTable ?? tables[0]?.name ?? null)
  }, [initialTable, tables])

  const table = React.useMemo(
    () => tables.find((tb) => tb.name === selected) ?? null,
    [tables, selected],
  )

  const loadFirstPage = React.useCallback(async () => {
    if (!selected) return
    setLoading(true)
    setError(null)
    setEdit(null)
    try {
      const first = await getBackend().apps.readAppDataRows(app.id, selected)
      setPage(first)
      setRows(first.rows)
    } catch (e) {
      setPage(null)
      setRows([])
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [app.id, selected])

  React.useEffect(() => {
    void loadFirstPage()
  }, [loadFirstPage])

  const handleLoadMore = async () => {
    if (!selected || !page?.nextCursor) return
    setLoadingMore(true)
    try {
      const next = await getBackend().apps.readAppDataRows(app.id, selected, {
        after: page.nextCursor,
      })
      setPage(next)
      setRows((prev) => [...prev, ...next.rows])
    } catch (e) {
      toast.error(t('apps.data.loadFailed', '读取数据失败'), {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setLoadingMore(false)
    }
  }

  const startEdit = (rowKey: string, row: Record<string, unknown>) => {
    if (!page) return
    const draft: Record<string, string> = {}
    for (const column of page.columns) {
      if (page.primaryKey.includes(column.name)) continue
      draft[column.name] = cellEditValue(row[column.name])
    }
    setEdit({ rowKey, draft })
  }

  const handleSave = async () => {
    if (!edit || !selected || !page) return
    const original = rows.find((r) => appDataRowKey(page.primaryKey, r) === edit.rowKey)
    if (!original) return
    const patch: Record<string, unknown> = {}
    for (const [column, text] of Object.entries(edit.draft)) {
      if (text === cellEditValue(original[column])) continue
      patch[column] = parseCellInput(text)
    }
    if (Object.keys(patch).length === 0) {
      setEdit(null)
      return
    }
    setSaving(true)
    try {
      const stored = await getBackend().apps.updateAppDataRow(app.id, selected, edit.rowKey, patch)
      setRows((prev) =>
        prev.map((r) => (appDataRowKey(page.primaryKey, r) === edit.rowKey ? stored : r)),
      )
      setEdit(null)
      toast.success(t('apps.data.rowSaved', '已保存'))
    } catch (e) {
      toast.error(t('apps.data.saveFailed', '保存失败'), {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!pendingDelete || !selected || !page) return
    setDeleting(true)
    try {
      await getBackend().apps.deleteAppDataRow(app.id, selected, pendingDelete)
      setRows((prev) => prev.filter((r) => appDataRowKey(page.primaryKey, r) !== pendingDelete))
      setPendingDelete(null)
      toast.success(t('apps.data.rowDeleted', '已删除'))
    } catch (e) {
      toast.error(t('apps.data.deleteFailed', '删除失败'), {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setDeleting(false)
    }
  }

  const rowActionsDisabled = !canEdit || !table?.editable

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="shrink-0 border-b border-border-soft px-4 py-3">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
            <Database className="h-4 w-4" />
            {t('apps.data.title', '线上数据')}
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {t('apps.data.subtitle', '{{name}} 的线上数据库。修改会立即生效。', {
              name: app.name,
            })}
          </p>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="w-48 shrink-0 overflow-auto border-r border-border-soft py-2">
            {tables.map((tb) => (
              <button
                key={tb.name}
                type="button"
                onClick={() => setSelected(tb.name)}
                className={cn(
                  'block w-full truncate px-3 py-1.5 text-left font-mono text-[12px]',
                  tb.name === selected
                    ? 'bg-paper font-semibold text-foreground'
                    : 'text-muted-foreground hover:bg-paper/60',
                )}
                data-testid={`app-data-table-${tb.name}`}
              >
                {tb.name}
                {!tb.editable && (
                  <span className="ml-1.5 text-[10px] text-faint">
                    {t('apps.data.readOnlyBadge', '只读')}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-soft px-3 py-2">
              <p className="truncate text-[11.5px] text-muted-foreground">
                {table && !table.editable
                  ? t(
                      'apps.data.noPrimaryKey',
                      '这张表没有主键，无法定位单行，因此只能查看。',
                    )
                  : t('apps.data.rowsShown', '已加载 {{count}} 行', { count: rows.length })}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 rounded-[7px] text-[12px]"
                disabled={loading}
                onClick={() => void loadFirstPage()}
              >
                <RotateCcw className="h-3 w-3" />
                {t('common.refresh', '刷新')}
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {loading ? (
                <div className="flex items-center gap-2 p-4 text-[12.5px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('common.loading', 'Loading…')}
                </div>
              ) : error ? (
                <p className="p-4 text-[12.5px] text-destructive" data-testid="app-data-error">
                  {error}
                </p>
              ) : !page || rows.length === 0 ? (
                <p className="p-4 text-[12.5px] text-muted-foreground" data-testid="app-data-empty-rows">
                  {t('apps.data.noRows', '这张表还没有数据。')}
                </p>
              ) : (
                <table className="w-full border-collapse text-[12px]">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b border-border-soft">
                      {page.columns.map((column) => (
                        <th
                          key={column.name}
                          className="whitespace-nowrap px-2.5 py-1.5 text-left font-mono text-[11px] font-semibold text-faint"
                        >
                          {column.name}
                        </th>
                      ))}
                      <th className="w-20 px-2.5 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const rowKey = appDataRowKey(page.primaryKey, row)
                      const editing = edit?.rowKey === rowKey
                      return (
                        <tr key={rowKey} className="border-b border-border-soft/60 align-top">
                          {page.columns.map((column) => {
                            const isKey = page.primaryKey.includes(column.name)
                            if (editing && !isKey) {
                              return (
                                <td key={column.name} className="px-2 py-1">
                                  <Input
                                    value={edit.draft[column.name] ?? ''}
                                    onChange={(e) =>
                                      setEdit((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              draft: {
                                                ...prev.draft,
                                                [column.name]: e.target.value,
                                              },
                                            }
                                          : prev,
                                      )
                                    }
                                    className="h-7 rounded-[6px] font-mono text-[11.5px]"
                                  />
                                </td>
                              )
                            }
                            const cell = formatAppDataCell(row[column.name], column.dataType)
                            return (
                              <td
                                key={column.name}
                                title={cell.detail ?? (cell.truncated ? cell.full : undefined)}
                                className={cn(
                                  'max-w-[280px] truncate px-2.5 py-1.5 font-mono text-[11.5px]',
                                  cell.kind === 'null' ? 'text-faint italic' : 'text-ink-2',
                                )}
                              >
                                {cell.display}
                              </td>
                            )
                          })}
                          <td className="px-2 py-1 text-right">
                            {editing ? (
                              <div className="flex justify-end gap-1">
                                <Button
                                  type="button"
                                  size="sm"
                                  className="h-6 rounded-[6px] px-2 text-[11px]"
                                  disabled={saving}
                                  onClick={() => void handleSave()}
                                >
                                  {saving ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    t('common.save', 'Save')
                                  )}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 rounded-[6px] px-2 text-[11px]"
                                  disabled={saving}
                                  onClick={() => setEdit(null)}
                                >
                                  {t('common.cancel', 'Cancel')}
                                </Button>
                              </div>
                            ) : (
                              <div className="flex justify-end gap-0.5">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 rounded-[6px] p-0"
                                  disabled={rowActionsDisabled}
                                  title={
                                    rowActionsDisabled
                                      ? !canEdit
                                        ? t('apps.data.editNeedsAdmin', '需要 admin 权限才能修改')
                                        : t(
                                            'apps.data.noPrimaryKey',
                                            '这张表没有主键，无法定位单行，因此只能查看。',
                                          )
                                      : t('apps.data.editRow', '编辑这一行')
                                  }
                                  data-testid={`app-data-edit-${rowKey}`}
                                  onClick={() => startEdit(rowKey, row)}
                                >
                                  <Pencil className="h-3 w-3" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 rounded-[6px] p-0 text-destructive"
                                  disabled={rowActionsDisabled}
                                  data-testid={`app-data-delete-${rowKey}`}
                                  onClick={() => setPendingDelete(rowKey)}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {page?.nextCursor && (
              <div className="shrink-0 border-t border-border-soft px-3 py-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 w-full rounded-[7px] text-[12px]"
                  disabled={loadingMore}
                  onClick={() => void handleLoadMore()}
                  data-testid="app-data-load-more"
                >
                  {loadingMore ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    t('apps.data.loadMore', '加载更多')
                  )}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('apps.data.deleteTitle', '删除这一行？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'apps.data.deleteHint',
                '这会直接从线上数据库删除，无法撤销。',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault()
                void handleDelete()
              }}
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('common.delete', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
