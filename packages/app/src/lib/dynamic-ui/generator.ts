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

