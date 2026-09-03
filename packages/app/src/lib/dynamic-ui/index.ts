// Barrel for the dynamic-UI toolkit. Hot paths should import the leaf module
// they need instead: `ChatMessage` pulls `parseStreamingUITree` and
// `extractUITreeFromResponse` directly and lazy-loads `DynamicUI`, so the
// catalog (zod + json-render schema) and the renderer stay off the startup path.
export { getUiCatalog, getCatalogPrompt, type CatalogComponentTypes } from "./catalog"
export { componentRegistry, fallbackComponent } from "./registry"
export { DynamicUI, DynamicUIMessage } from "./DynamicUI"
export { buildUIGenerationPrompt } from "./prompt"
export { extractUITreeFromResponse } from "./generator"
export { parseStreamingUITree, type StreamingUIState } from "./streaming"
