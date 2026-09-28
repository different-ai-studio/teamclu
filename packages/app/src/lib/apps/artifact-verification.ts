export interface ArtifactVerification {
  status: string
  unknownFiles: string[]
  revision: string
}

export function artifactVerificationError(verification: ArtifactVerification | null, revision: string): string | null {
  if (verification?.status === 'checked' && verification.revision === revision && verification.unknownFiles?.length === 0) return null
  const files = verification?.unknownFiles?.length ? ` (${verification.unknownFiles.join(', ')})` : ''
  return `artifact_verification_unknown: selected daemon could not verify the Linux/x86_64 artifact${files}; run an explicit target-runtime test before publishing`
}
