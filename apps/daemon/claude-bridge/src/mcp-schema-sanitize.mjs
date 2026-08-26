/** @typedef {Record<string, unknown>} JsonSchema */

const COMBINERS = ['oneOf', 'anyOf', 'allOf']

/**
 * Anthropic custom tools reject MCP schemas whose top-level input_schema uses
 * oneOf / anyOf / allOf. Flatten those into a plain object schema.
 *
 * @param {unknown} schema
 * @returns {JsonSchema}
 */
export function sanitizeToolInputSchema(schema) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} }
  }
  const cleaned = sanitizeNode(/** @type {JsonSchema} */ (schema), true)
  if (hasTopLevelCombiner(cleaned)) {
    return flattenCombiner(cleaned)
  }
  if (!cleaned.type) cleaned.type = 'object'
  if (cleaned.type === 'object' && !cleaned.properties) cleaned.properties = {}
  return cleaned
}

/** @param {JsonSchema} schema */
function hasTopLevelCombiner(schema) {
  return COMBINERS.some((key) => Array.isArray(schema[key]) && schema[key].length > 0)
}

/** @param {JsonSchema} schema @param {boolean} topLevel */
function sanitizeNode(schema, topLevel) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) {
    return topLevel ? { type: 'object', properties: {} } : { type: 'string' }
  }

  if (topLevel && hasTopLevelCombiner(schema)) {
    return flattenCombiner(schema)
  }

  /** @type {JsonSchema} */
  const out = {}

  for (const [key, value] of Object.entries(schema)) {
    if (topLevel && COMBINERS.includes(key)) continue

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      /** @type {JsonSchema} */
      const props = {}
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = sanitizePropertySchema(propSchema)
      }
      out.properties = props
      continue
    }

    if (key === 'patternProperties' && value && typeof value === 'object' && !Array.isArray(value)) {
      /** @type {JsonSchema} */
      const props = {}
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = sanitizePropertySchema(propSchema)
      }
      out.patternProperties = props
      continue
    }

    if (key === 'items') {
      out.items = Array.isArray(value)
        ? value.map((item) => sanitizePropertySchema(item))
        : sanitizePropertySchema(value)
      continue
    }

    if (key === 'additionalProperties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.additionalProperties = sanitizePropertySchema(value)
      continue
    }

    if (key === 'definitions' && value && typeof value === 'object' && !Array.isArray(value)) {
      /** @type {JsonSchema} */
      const defs = {}
      for (const [defName, defSchema] of Object.entries(value)) {
        defs[defName] = sanitizePropertySchema(defSchema)
      }
      out.definitions = defs
      continue
    }

    if (key === '$defs' && value && typeof value === 'object' && !Array.isArray(value)) {
      /** @type {JsonSchema} */
      const defs = {}
      for (const [defName, defSchema] of Object.entries(value)) {
        defs[defName] = sanitizePropertySchema(defSchema)
      }
      out.$defs = defs
      continue
    }

    out[key] = value
  }

  if (topLevel) {
    if (!out.type) out.type = 'object'
    if (out.type === 'object' && !out.properties && out.additionalProperties === undefined) {
      out.properties = {}
    }
  }

  return out
}

/** @param {unknown} schema */
function sanitizePropertySchema(schema) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'string' }
  }
  const node = /** @type {JsonSchema} */ (schema)
  if (hasTopLevelCombiner(node)) return flattenCombiner(node)
  return sanitizeNode(node, false)
}

/** @param {JsonSchema} schema */
function flattenCombiner(schema) {
  const combinerKey = COMBINERS.find((key) => Array.isArray(schema[key]) && schema[key].length > 0)
  if (!combinerKey) {
    return { type: 'object', properties: {} }
  }

  const branches = /** @type {JsonSchema[]} */ (schema[combinerKey])
  const isAllOf = combinerKey === 'allOf'

  /** @type {JsonSchema} */
  const merged = { type: 'object', properties: {} }
  /** @type {Set<string>} */
  const required = new Set()

  for (const branch of branches) {
    const flat = sanitizePropertySchema(branch)
    if (flat.type === 'object' || flat.properties) {
      Object.assign(merged.properties, flat.properties ?? {})
      for (const name of flat.required ?? []) {
        if (typeof name === 'string') required.add(name)
      }
    } else if (flat.type) {
      merged.properties.value ??= flat
    } else if (flat.$ref && typeof flat.$ref === 'string') {
      merged.properties.value ??= { type: 'string', description: `See ${flat.$ref}` }
    }
  }

  if (isAllOf && required.size > 0) {
    merged.required = [...required]
  }

  if (schema.description && typeof schema.description === 'string') {
    merged.description = schema.description
  } else if (!isAllOf && branches.length > 1) {
    merged.description = 'Provide one of the supported argument shapes.'
  }

  if (!merged.properties || Object.keys(merged.properties).length === 0) {
    merged.properties = {}
    merged.additionalProperties = true
  }

  return merged
}
