import type { UIElement } from "@json-render/core"

/**
 * 流式解析得到的扁平 UI 树（`{ root, elements }`，即 0.19 的合法 `Spec` 形状）。
 */
export type UITree = {
  root: string
  elements: Record<string, UIElement>
}

/**
 * 流式 UI 解析状态
 */
export interface StreamingUIState {
  tree: UITree | null
  isComplete: boolean
  elementCount: number
}

/**
 * 从流式文本中增量解析 UITree
 * 
 * 策略：
 * 1. 查找 "root" 字段获取根元素 key
 * 2. 逐个解析 elements 中的元素
 * 3. 即使 JSON 不完整也尝试渲染已解析的部分
 */
export function parseStreamingUITree(content: string): StreamingUIState {
  // 初始状态
  const state: StreamingUIState = {
    tree: null,
    isComplete: false,
    elementCount: 0,
  }

  const jsonStart = content.indexOf('{')
  if (jsonStart === -1) {
    return state
  }

  const jsonContent = content.slice(jsonStart)

  // PERF: Fast reject — a valid UITree must contain "root" and "elements" keys.
  // Skip expensive JSON.parse + regex for normal markdown that happens to contain '{'.
  if (!jsonContent.includes('"root"') || !jsonContent.includes('"elements"')) {
    return state
  }

  // 尝试解析完整的 JSON
  try {
    const parsed = JSON.parse(jsonContent)
    if (isValidUITree(parsed)) {
      return {
        tree: parsed,
        isComplete: true,
        elementCount: Object.keys(parsed.elements || {}).length,
      }
    }
  } catch {
    // JSON 不完整，尝试增量解析
  }

  // 增量解析策略
  const partialTree = parsePartialUITree(jsonContent)
  if (partialTree) {
    return {
      tree: partialTree,
      isComplete: false,
      elementCount: Object.keys(partialTree.elements || {}).length,
    }
  }

  return state
}

/**
 * 解析部分 UITree
 */
function parsePartialUITree(content: string): UITree | null {
  const elements: Record<string, UIElement> = {}
  let root: string | null = null

  // 提取 root 字段
  const rootMatch = content.match(/"root"\s*:\s*"([^"]+)"/)
  if (rootMatch) {
    root = rootMatch[1]
  }

  // 提取 elements 部分
  const elementsMatch = content.match(/"elements"\s*:\s*\{/)
  if (!elementsMatch) {
    return null
  }

  // 尝试解析每个元素
  // 查找形如 "key": { ... } 的模式
  const elementPattern = /"([^"]+)"\s*:\s*\{[^{}]*"key"\s*:\s*"[^"]+"/g
  let match

  while ((match = elementPattern.exec(content)) !== null) {
    const elementKey = match[1]
    const startPos = match.index + match[0].indexOf('{')
    
    // 尝试找到这个元素的完整 JSON
    const elementJson = extractCompleteObject(content, startPos)
    if (elementJson) {
      try {
        const element = JSON.parse(elementJson)
        if (element.key && element.type) {
          elements[elementKey] = element
        }
      } catch {
        // 解析失败，跳过这个元素
      }
    }
  }

  // 如果没有解析到任何元素，返回 null
  if (Object.keys(elements).length === 0) {
    return null
  }

  // 如果没有 root，使用第一个元素
  if (!root && Object.keys(elements).length > 0) {
    root = Object.keys(elements)[0]
  }

  return {
    root: root || "root",
    elements,
  }
}

/**
 * 从指定位置提取完整的 JSON 对象
 */
function extractCompleteObject(content: string, startPos: number): string | null {
  if (content[startPos] !== '{') {
    return null
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = startPos; i < content.length; i++) {
    const char = content[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) {
      continue
    }

    if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        return content.slice(startPos, i + 1)
      }
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

