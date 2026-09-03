/** Strip in-page anchor hashes (#section) but keep SPA route hashes (#/…, #!/…). */
function shouldPreserveHash(hash: string): boolean {
  return hash.startsWith('#/') || hash.startsWith('#!/')
}

export function normalizeLinkKey(href: string): string {
  const url = new URL(href)
  if (url.hash && !shouldPreserveHash(url.hash)) {
    url.hash = ''
  }
  return url.toString()
}

export function buildLinkSessionCompositeKey(teamId: string, href: string): string {
  return `${teamId}::${normalizeLinkKey(href)}`
}
