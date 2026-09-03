import * as React from "react"
import { useTranslation } from "react-i18next"
import type { Spec } from "@json-render/core"
import { JSONUIProvider, Renderer } from "@json-render/react"
import { componentRegistry, fallbackComponent } from "@/lib/dynamic-ui/registry"

interface DynamicUIProps {
  /** UI 树结构（0.19 的 Spec） */
  tree: Spec | null
  /** 是否正在加载/流式传输 */
  loading?: boolean
  /** 初始数据模型 */
  initialData?: Record<string, unknown>
  /** 数据变化回调 */
  onDataChange?: (path: string, value: unknown) => void
  /** Action 处理器 */
  actionHandlers?: Record<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>
}

/**
 * 动态 UI 渲染组件
 * 接收 json-render 格式的 UI 树并渲染为实际的 React 组件
 */
export function DynamicUI({
  tree,
  loading = false,
  initialData = {},
  onDataChange,
  actionHandlers = {},
}: DynamicUIProps) {
  if (!tree) {
    return null
  }

  return (
    <JSONUIProvider
      registry={componentRegistry}
      initialState={initialData}
      handlers={actionHandlers}
      onStateChange={
        onDataChange
          ? (changes) => changes.forEach((c) => onDataChange(c.path, c.value))
          : undefined
      }
    >
      <div className="w-full">
        <Renderer
          spec={tree}
          registry={componentRegistry}
          loading={loading}
          fallback={fallbackComponent}
        />
      </div>
    </JSONUIProvider>
  )
}

/**
 * 动态 UI 消息
 * 在对话中直接显示生成的 UI，不添加额外包装
 */
interface DynamicUIMessageProps {
  tree: Spec | null
  loading?: boolean
  title?: string // 保留但不使用，保持 API 兼容
}

export function DynamicUIMessage({ tree, loading = false }: DynamicUIMessageProps) {
  const { t } = useTranslation()
  const [formData, setFormData] = React.useState<Record<string, unknown>>({})

  const handleDataChange = (path: string, value: unknown) => {
    setFormData((prev) => {
      const newData = { ...prev }
      // 简单的路径设置，支持顶级路径
      const cleanPath = path.startsWith("/") ? path.slice(1) : path
      newData[cleanPath] = value
      return newData
    })
  }

  const actionHandlers = {
    submit: async (params: Record<string, unknown>) => {
      console.log("Form submitted:", params, formData)
      // 这里可以添加实际的表单提交逻辑
      return { success: true, data: formData }
    },
    setData: async (params: Record<string, unknown>) => {
      const { path, value } = params as { path: string; value: unknown }
      handleDataChange(path, value)
      return { success: true }
    },
  }

  if (!tree) {
    if (loading) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span>{t("dynamicUi.generating", "Generating interface...")}</span>
        </div>
      )
    }
    return null
  }

  return (
    <DynamicUI
      tree={tree}
      loading={loading}
      initialData={formData}
      onDataChange={handleDataChange}
      actionHandlers={actionHandlers}
    />
  )
}
