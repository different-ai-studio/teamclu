/**
 * `public.<table>` on a client whose default schema is `amux`.
 *
 * Falls back to the default schema for in-memory test stubs that lack
 * `.schema()`.
 */
export function publicFrom(supabase: any, table: string) {
  if (typeof supabase?.schema === "function") {
    return supabase.schema("public").from(table);
  }
  return supabase.from(table);
}
