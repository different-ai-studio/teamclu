import { z } from "zod"
import { schema } from "@json-render/react"

/**
 * 定义可供 AI 使用的组件目录
 * 这些组件基于项目中现有的 shadcn/ui 组件
 *
 * 0.19 起 catalog 通过 `schema.createCatalog(...)` 创建：
 * - `hasChildren: true` → `slots: ["default"]`
 * - 提示词由 `catalog.prompt()` 生成（取代旧的 `generateCatalogPrompt`）
 */
function buildCatalog() {
  return schema.createCatalog({
    components: {
      // 布局组件
      Card: {
        props: z.object({
          title: z.string().optional().describe("卡片标题"),
          description: z.string().optional().describe("卡片描述"),
        }),
        slots: ["default"],
        description: "卡片容器，用于分组相关内容",
      },

      // 表单组件
      Form: {
        props: z.object({
          id: z.string().describe("表单ID，用于提交"),
        }),
        slots: ["default"],
        description: "表单容器，包含表单字段",
      },

      FormField: {
        props: z.object({
          label: z.string().describe("字段标签"),
          name: z.string().describe("字段名称，用于数据绑定"),
          required: z.boolean().optional().describe("是否必填"),
        }),
        slots: ["default"],
        description: "表单字段容器，包含标签和输入控件",
      },

      Input: {
        props: z.object({
          placeholder: z.string().optional().describe("占位符文本"),
          type: z.enum(["text", "email", "password", "number", "tel", "url"]).optional().describe("输入类型"),
          valuePath: z.string().optional().describe("数据绑定路径"),
          disabled: z.boolean().optional().describe("是否禁用"),
        }),
        description: "文本输入框",
      },

      Textarea: {
        props: z.object({
          placeholder: z.string().optional().describe("占位符文本"),
          valuePath: z.string().optional().describe("数据绑定路径"),
          rows: z.number().optional().describe("显示行数"),
          disabled: z.boolean().optional().describe("是否禁用"),
        }),
        description: "多行文本输入框",
      },

      Select: {
        props: z.object({
          placeholder: z.string().optional().describe("占位符文本"),
          valuePath: z.string().optional().describe("数据绑定路径"),
          options: z.array(z.object({
            value: z.string(),
            label: z.string(),
          })).describe("选项列表"),
          disabled: z.boolean().optional().describe("是否禁用"),
        }),
        description: "下拉选择框",
      },

      // 按钮组件
      Button: {
        props: z.object({
          label: z.string().describe("按钮文本"),
          variant: z.enum(["default", "destructive", "outline", "secondary", "ghost", "link"]).optional().describe("按钮样式"),
          size: z.enum(["default", "sm", "lg", "icon"]).optional().describe("按钮大小"),
          disabled: z.boolean().optional().describe("是否禁用"),
        }),
        description: "按钮，用于触发操作",
      },

      // 显示组件
      Text: {
        props: z.object({
          content: z.string().describe("文本内容"),
          variant: z.enum(["default", "muted", "heading", "label"]).optional().describe("文本样式"),
        }),
        description: "文本显示",
      },

      Badge: {
        props: z.object({
          label: z.string().describe("徽章文本"),
          variant: z.enum(["default", "secondary", "destructive", "outline"]).optional().describe("徽章样式"),
        }),
        description: "徽章，用于显示状态或标签",
      },

      Divider: {
        props: z.object({
          orientation: z.enum(["horizontal", "vertical"]).optional().describe("分隔线方向"),
        }),
        description: "分隔线",
      },

      // 布局辅助
      Stack: {
        props: z.object({
          direction: z.enum(["row", "column"]).optional().describe("排列方向"),
          gap: z.enum(["sm", "md", "lg"]).optional().describe("间距大小"),
          align: z.enum(["start", "center", "end", "stretch"]).optional().describe("对齐方式"),
          justify: z.enum(["start", "center", "end", "between", "around"]).optional().describe("主轴对齐"),
        }),
        slots: ["default"],
        description: "弹性布局容器",
      },

      // 数据展示
      Metric: {
        props: z.object({
          label: z.string().describe("指标标签"),
          valuePath: z.string().optional().describe("数据绑定路径"),
          value: z.union([z.string(), z.number()]).optional().describe("静态值"),
          format: z.enum(["number", "currency", "percent"]).optional().describe("格式化类型"),
        }),
        description: "指标展示，用于显示数值数据",
      },
    },

    actions: {
      submit: {
        params: z.object({
          formId: z.string().describe("要提交的表单ID"),
        }),
        description: "提交表单数据",
      },
      navigate: {
        params: z.object({
          path: z.string().describe("导航路径"),
        }),
        description: "页面导航",
      },
      setData: {
        params: z.object({
          path: z.string().describe("数据路径"),
          value: z.unknown().describe("要设置的值"),
        }),
        description: "设置数据模型中的值",
      },
    },
  })
}

type UiCatalog = ReturnType<typeof buildCatalog>

let uiCatalog: UiCatalog | null = null
let catalogPrompt: string | null = null

/**
 * 组件目录（首次调用时构建）。
 *
 * Building the catalog walks every zod schema above and is only needed to
 * compose a generation prompt, so it happens on first use rather than at
 * import time — the chat renderer imports this package's parsers without
 * ever asking for the catalog.
 */
export function getUiCatalog(): UiCatalog {
  uiCatalog ??= buildCatalog()
  return uiCatalog
}

/**
 * 生成用于 AI 的组件目录提示词（首次调用时生成并缓存）
 */
export function getCatalogPrompt(): string {
  catalogPrompt ??= getUiCatalog().prompt()
  return catalogPrompt
}

/**
 * 组件类型
 */
export type CatalogComponentTypes = keyof UiCatalog["data"]["components"]
