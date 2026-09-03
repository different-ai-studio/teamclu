import { getCatalogPrompt } from "./catalog"

/**
 * Prompt construction for AI-driven UI generation.
 *
 * Kept apart from `generator.ts` on purpose: the prompt embeds the component
 * catalog, whose build pulls in zod and json-render's schema helpers. The chat
 * renderer only needs `extractUITreeFromResponse` from the generator, and must
 * not drag the catalog into the startup chunk with it.
 */

/**
 * 生成发送给 AI 的 UI 生成提示词
 */
export function buildUIGenerationPrompt(userRequest: string): string {
  return `你是一个 UI 生成助手。请根据用户需求生成一个 UI 界面的 JSON 描述。

## 可用组件目录

${getCatalogPrompt()}

## 输出格式

请严格按照以下 JSON 格式输出 UI 树结构：

\`\`\`json
{
  "root": "根元素的key",
  "elements": {
    "key1": {
      "key": "key1",
      "type": "组件类型",
      "props": { ... },
      "children": ["子元素key"],
      "parentKey": "父元素key或null"
    }
  }
}
\`\`\`

## 重要规则

1. 每个元素必须有唯一的 key
2. 只使用目录中定义的组件类型
3. props 必须符合组件的 schema 定义
4. children 数组包含子元素的 key
5. parentKey 指向父元素（根元素为 null）
6. 只输出 JSON，不要输出其他内容

## 用户需求

${userRequest}

请生成对应的 UI JSON：`
}
