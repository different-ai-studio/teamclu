/**
 * `React.memo` comparator for list rows whose callbacks read the latest
 * handlers through a ref at call time, so a callback's identity carries no
 * information — only whether one is given does.
 *
 * Data is compared by value down to `depth` levels of arrays and plain
 * objects: the feed rebuilds its item objects on every update, so identity
 * alone would re-render every row anyway. Anything deeper, or not a plain
 * object, counts as changed unless it is the same reference — the safe side.
 */
export function propsEqualIgnoringFunctions<P extends object>(prev: P, next: P, depth = 4): boolean {
  return equalValue(prev, next, depth);
}

function equalValue(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === "function" && typeof b === "function") return true;
  if (depth <= 0 || typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equalValue(a[i], b[i], depth - 1)) return false;
    }
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!equalValue(a[key], b[key], depth - 1)) return false;
  }
  return true;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
