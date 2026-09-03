// Barrel for the dynamic-UI toolkit. Hot paths should import the leaf module
// they need instead: `ChatMessage` pulls `parseStreamingUITree` and
// `extractUITreeFromResponse` directly and lazy-loads `DynamicUI`, so the
// catalog (zod + json-render schema) and the renderer stay off the startup path.
export { getUiCatalog, getCatalogPrompt, type CatalogComponentTypes } from "@/lib/dynamic-ui/catalog"
export { componentRegistry, fallbackComponent } from "@/lib/dynamic-ui/registry"
export { DynamicUI, DynamicUIMessage } from "@/lib/dynamic-ui/DynamicUI"
export { buildUIGenerationPrompt } from "@/lib/dynamic-ui/prompt"
export { extractUITreeFromResponse } from "@/lib/dynamic-ui/generator"
export { parseStreamingUITree, type StreamingUIState } from "@/lib/dynamic-ui/streaming"
