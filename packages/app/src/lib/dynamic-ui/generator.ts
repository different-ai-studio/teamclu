import type { FlatElement, Spec } from "@json-render/core"

/**
 * AI 生成的扁平 UI 树。
 *
 * 0.19 的 `Spec.elements` 用 `UIElement`（无 key/parentKey），而历史模板与 AI
 * 输出沿用带 `key`/`parentKey` 的 `FlatElement` 形状。两者均为合法 `Spec`
 * （`FlatElement extends UIElement`），故本地保留 `UITree` 别名以减少改动面。
 */
export type UITree = Pick<Spec, "root"> & {
  elements: Record<string, FlatElement>
}

/**
 * 从 AI 响应中提取 UITree JSON
 */
export function extractUITreeFromResponse(response: string): UITree | null {
  try {
    // 尝试直接解析整个响应
    const parsed = JSON.parse(response)
    if (isValidUITree(parsed)) {
      return parsed
    }
  } catch {
    // 继续尝试其他方法
  }

  // 尝试从 markdown 代码块中提取
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim())
      if (isValidUITree(parsed)) {
        return parsed
      }
    } catch {
      // 继续尝试
    }
  }

  // 尝试查找 JSON 对象
  const jsonObjectMatch = response.match(/\{[\s\S]*"root"[\s\S]*"elements"[\s\S]*\}/)
  if (jsonObjectMatch) {
    try {
      const parsed = JSON.parse(jsonObjectMatch[0])
      if (isValidUITree(parsed)) {
        return parsed
      }
    } catch {
      // 解析失败
    }
  }

  return null
}

/**
 * 验证是否是有效的 UITree
 */
function isValidUITree(obj: unknown): obj is UITree {
  if (!obj || typeof obj !== 'object') return false
  const tree = obj as Record<string, unknown>
  return (
    typeof tree.root === 'string' &&
    typeof tree.elements === 'object' &&
    tree.elements !== null
  )
}

/**
 * 预定义的 UI 模板（作为 fallback）
 */
const uiTemplates: Record<string, () => UITree> = {
  // 登录表单
  login: () => ({
    root: "card",
    elements: {
      card: {
        key: "card",
        type: "Card",
        props: { title: "用户登录", description: "请输入您的账号信息" },
        children: ["form"],
      },
      form: {
        key: "form",
        type: "Form",
        props: { id: "login-form" },
        children: ["email-field", "password-field", "actions"],
        parentKey: "card",
      },
      "email-field": {
        key: "email-field",
        type: "FormField",
        props: { label: "邮箱", name: "email", required: true },
        children: ["email-input"],
        parentKey: "form",
      },
      "email-input": {
        key: "email-input",
        type: "Input",
        props: { type: "email", placeholder: "请输入邮箱地址", valuePath: "/email" },
        parentKey: "email-field",
      },
      "password-field": {
        key: "password-field",
        type: "FormField",
        props: { label: "密码", name: "password", required: true },
        children: ["password-input"],
        parentKey: "form",
      },
      "password-input": {
        key: "password-input",
        type: "Input",
        props: { type: "password", placeholder: "请输入密码", valuePath: "/password" },
        parentKey: "password-field",
      },
      actions: {
        key: "actions",
        type: "Stack",
        props: { direction: "row", gap: "md", justify: "end" },
        children: ["submit-btn"],
        parentKey: "form",
      },
      "submit-btn": {
        key: "submit-btn",
        type: "Button",
        props: { label: "登录", variant: "default" },
        parentKey: "actions",
      },
    },
  }),

  // 注册表单
  register: () => ({
    root: "card",
    elements: {
      card: {
        key: "card",
        type: "Card",
        props: { title: "用户注册", description: "创建您的新账号" },
        children: ["form"],
      },
      form: {
        key: "form",
        type: "Form",
        props: { id: "register-form" },
        children: ["name-field", "email-field", "password-field", "confirm-field", "actions"],
        parentKey: "card",
      },
      "name-field": {
        key: "name-field",
        type: "FormField",
        props: { label: "姓名", name: "name", required: true },
        children: ["name-input"],
        parentKey: "form",
      },
      "name-input": {
        key: "name-input",
        type: "Input",
        props: { type: "text", placeholder: "请输入您的姓名", valuePath: "/name" },
        parentKey: "name-field",
      },
      "email-field": {
        key: "email-field",
        type: "FormField",
        props: { label: "邮箱", name: "email", required: true },
        children: ["email-input"],
        parentKey: "form",
      },
      "email-input": {
        key: "email-input",
        type: "Input",
        props: { type: "email", placeholder: "请输入邮箱地址", valuePath: "/email" },
        parentKey: "email-field",
      },
      "password-field": {
        key: "password-field",
        type: "FormField",
        props: { label: "密码", name: "password", required: true },
        children: ["password-input"],
        parentKey: "form",
      },
      "password-input": {
        key: "password-input",
        type: "Input",
        props: { type: "password", placeholder: "请设置密码", valuePath: "/password" },
        parentKey: "password-field",
      },
      "confirm-field": {
        key: "confirm-field",
        type: "FormField",
        props: { label: "确认密码", name: "confirmPassword", required: true },
        children: ["confirm-input"],
        parentKey: "form",
      },
      "confirm-input": {
        key: "confirm-input",
        type: "Input",
        props: { type: "password", placeholder: "请再次输入密码", valuePath: "/confirmPassword" },
        parentKey: "confirm-field",
      },
      actions: {
        key: "actions",
        type: "Stack",
        props: { direction: "row", gap: "md", justify: "end" },
        children: ["submit-btn"],
        parentKey: "form",
      },
      "submit-btn": {
        key: "submit-btn",
        type: "Button",
        props: { label: "注册", variant: "default" },
        parentKey: "actions",
      },
    },
  }),

  // 反馈表单
  feedback: () => ({
    root: "card",
    elements: {
      card: {
        key: "card",
        type: "Card",
        props: { title: "用户反馈", description: "请告诉我们您的想法" },
        children: ["form"],
      },
      form: {
        key: "form",
        type: "Form",
        props: { id: "feedback-form" },
        children: ["type-field", "message-field", "actions"],
        parentKey: "card",
      },
      "type-field": {
        key: "type-field",
        type: "FormField",
        props: { label: "反馈类型", name: "type", required: true },
        children: ["type-select"],
        parentKey: "form",
      },
      "type-select": {
        key: "type-select",
        type: "Select",
        props: {
          placeholder: "请选择反馈类型",
          valuePath: "/feedbackType",
          options: [
            { value: "bug", label: "Bug 报告" },
            { value: "feature", label: "功能建议" },
            { value: "improvement", label: "改进意见" },
            { value: "other", label: "其他" },
          ],
        },
        parentKey: "type-field",
      },
      "message-field": {
        key: "message-field",
        type: "FormField",
        props: { label: "详细描述", name: "message", required: true },
        children: ["message-textarea"],
        parentKey: "form",
      },
      "message-textarea": {
        key: "message-textarea",
        type: "Textarea",
        props: { placeholder: "请详细描述您的反馈...", rows: 4, valuePath: "/message" },
        parentKey: "message-field",
      },
      actions: {
        key: "actions",
        type: "Stack",
        props: { direction: "row", gap: "md", justify: "end" },
        children: ["cancel-btn", "submit-btn"],
        parentKey: "form",
      },
      "cancel-btn": {
        key: "cancel-btn",
        type: "Button",
        props: { label: "取消", variant: "outline" },
        parentKey: "actions",
      },
      "submit-btn": {
        key: "submit-btn",
        type: "Button",
        props: { label: "提交反馈", variant: "default" },
        parentKey: "actions",
      },
    },
  }),

  // 仪表盘
  dashboard: () => ({
    root: "stack",
    elements: {
      stack: {
        key: "stack",
        type: "Stack",
        props: { direction: "column", gap: "lg" },
        children: ["header", "metrics", "details"],
      },
      header: {
        key: "header",
        type: "Text",
        props: { content: "数据概览", variant: "heading" },
        parentKey: "stack",
      },
      metrics: {
        key: "metrics",
        type: "Stack",
        props: { direction: "row", gap: "md" },
        children: ["metric1", "metric2", "metric3"],
        parentKey: "stack",
      },
      metric1: {
        key: "metric1",
        type: "Card",
        props: { title: "总用户数" },
        children: ["metric1-value"],
        parentKey: "metrics",
      },
      "metric1-value": {
        key: "metric1-value",
        type: "Metric",
        props: { label: "用户", value: 12580, format: "number" },
        parentKey: "metric1",
      },
      metric2: {
        key: "metric2",
        type: "Card",
        props: { title: "月收入" },
        children: ["metric2-value"],
        parentKey: "metrics",
      },
      "metric2-value": {
        key: "metric2-value",
        type: "Metric",
        props: { label: "收入", value: 458000, format: "currency" },
        parentKey: "metric2",
      },
      metric3: {
        key: "metric3",
        type: "Card",
        props: { title: "增长率" },
        children: ["metric3-value"],
        parentKey: "metrics",
      },
      "metric3-value": {
        key: "metric3-value",
        type: "Metric",
        props: { label: "增长", value: 23.5, format: "percent" },
        parentKey: "metric3",
      },
      details: {
        key: "details",
        type: "Card",
        props: { title: "最近活动", description: "用户最近的操作记录" },
        children: ["detail-text"],
        parentKey: "stack",
      },
      "detail-text": {
        key: "detail-text",
        type: "Text",
        props: { content: "暂无最近活动记录", variant: "muted" },
        parentKey: "details",
      },
    },
  }),

  // 联系表单
  contact: () => ({
    root: "card",
    elements: {
      card: {
        key: "card",
        type: "Card",
        props: { title: "联系我们", description: "填写以下信息，我们会尽快回复您" },
        children: ["form"],
      },
      form: {
        key: "form",
        type: "Form",
        props: { id: "contact-form" },
        children: ["name-field", "email-field", "subject-field", "message-field", "actions"],
        parentKey: "card",
      },
      "name-field": {
        key: "name-field",
        type: "FormField",
        props: { label: "姓名", name: "name", required: true },
        children: ["name-input"],
        parentKey: "form",
      },
      "name-input": {
        key: "name-input",
        type: "Input",
        props: { type: "text", placeholder: "请输入您的姓名", valuePath: "/name" },
        parentKey: "name-field",
      },
      "email-field": {
        key: "email-field",
        type: "FormField",
        props: { label: "邮箱", name: "email", required: true },
        children: ["email-input"],
        parentKey: "form",
      },
      "email-input": {
        key: "email-input",
        type: "Input",
        props: { type: "email", placeholder: "请输入邮箱地址", valuePath: "/email" },
        parentKey: "email-field",
      },
      "subject-field": {
        key: "subject-field",
        type: "FormField",
        props: { label: "主题", name: "subject", required: true },
        children: ["subject-input"],
        parentKey: "form",
      },
      "subject-input": {
        key: "subject-input",
        type: "Input",
        props: { type: "text", placeholder: "请输入主题", valuePath: "/subject" },
        parentKey: "subject-field",
      },
      "message-field": {
        key: "message-field",
        type: "FormField",
        props: { label: "消息内容", name: "message", required: true },
        children: ["message-textarea"],
        parentKey: "form",
      },
      "message-textarea": {
        key: "message-textarea",
        type: "Textarea",
        props: { placeholder: "请输入您的消息...", rows: 5, valuePath: "/message" },
        parentKey: "message-field",
      },
      actions: {
        key: "actions",
        type: "Stack",
        props: { direction: "row", gap: "md", justify: "end" },
        children: ["submit-btn"],
        parentKey: "form",
      },
      "submit-btn": {
        key: "submit-btn",
        type: "Button",
        props: { label: "发送消息", variant: "default" },
        parentKey: "actions",
      },
    },
  }),
}

/**
 * 检测用户输入是否是 UI 生成请求
 */
export function isUIGenerationRequest(prompt: string): boolean {
  const uiKeywords = [
    "创建", "生成", "做一个", "帮我做", "设计",
    "表单", "界面", "页面", "组件", "UI",
    "登录", "注册", "反馈", "联系", "仪表盘", "dashboard",
    "form", "create", "generate", "build", "make",
  ]
  
  const lowerPrompt = prompt.toLowerCase()
  return uiKeywords.some(keyword => lowerPrompt.includes(keyword.toLowerCase()))
}

/**
 * 根据用户输入匹配 UI 模板
 */
function matchTemplate(prompt: string): string | null {
  const lowerPrompt = prompt.toLowerCase()
  
  if (lowerPrompt.includes("登录") || lowerPrompt.includes("login")) {
    return "login"
  }
  if (lowerPrompt.includes("注册") || lowerPrompt.includes("register") || lowerPrompt.includes("signup")) {
    return "register"
  }
  if (lowerPrompt.includes("反馈") || lowerPrompt.includes("feedback")) {
    return "feedback"
  }
  if (lowerPrompt.includes("仪表") || lowerPrompt.includes("dashboard") || lowerPrompt.includes("数据")) {
    return "dashboard"
  }
  if (lowerPrompt.includes("联系") || lowerPrompt.includes("contact")) {
    return "contact"
  }
  
  return null
}

/**
 * 根据用户输入生成 UI
 * 在实际应用中，这会调用 AI API
 */
export async function generateUI(prompt: string): Promise<{
  tree: UITree | null
  title: string
  error?: string
}> {
  // 模拟网络延迟
  await new Promise(resolve => setTimeout(resolve, 500))
  
  const templateKey = matchTemplate(prompt)
  
  if (templateKey && uiTemplates[templateKey]) {
    return {
      tree: uiTemplates[templateKey](),
      title: `生成的界面: ${templateKey}`,
    }
  }
  
  // 如果没有匹配到模板，返回一个通用的表单
  return {
    tree: {
      root: "card",
      elements: {
        card: {
          key: "card",
          type: "Card",
          props: { 
            title: "自定义表单", 
            description: "根据您的需求生成的界面" 
          },
          children: ["content"],
        },
        content: {
          key: "content",
          type: "Stack",
          props: { direction: "column", gap: "md" },
          children: ["text", "input-field", "button"],
          parentKey: "card",
        },
        text: {
          key: "text",
          type: "Text",
          props: { content: `您的请求: "${prompt}"`, variant: "muted" },
          parentKey: "content",
        },
        "input-field": {
          key: "input-field",
          type: "FormField",
          props: { label: "输入", name: "input" },
          children: ["input"],
          parentKey: "content",
        },
        input: {
          key: "input",
          type: "Input",
          props: { placeholder: "请输入...", valuePath: "/input" },
          parentKey: "input-field",
        },
        button: {
          key: "button",
          type: "Button",
          props: { label: "提交", variant: "default" },
          parentKey: "content",
        },
      },
    },
    title: "自定义界面",
  }
}

/**
 * 获取可用的 UI 模板列表
 */
export function getAvailableTemplates(): string[] {
  return Object.keys(uiTemplates)
}
