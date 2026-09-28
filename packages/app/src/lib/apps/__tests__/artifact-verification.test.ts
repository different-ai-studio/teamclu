import { describe, expect, it } from 'vitest'
import { artifactVerificationError } from '../artifact-verification'

describe('artifact verification before deploy finalize', () => {
  it('requires an explicit target runtime test when native bytes are unknown', () => {
    expect(artifactVerificationError({ status: 'unknown', unknownFiles: ['native.so'], revision: 'abc' }, 'abc'))
      .toContain('Linux/x86_64')
  })

  it('requires verification metadata and accepts checked artifacts', () => {
    expect(artifactVerificationError(null, 'abc')).toContain('artifact_verification_unknown')
    expect(artifactVerificationError({ status: 'checked', unknownFiles: [], revision: 'abc' }, 'abc')).toBeNull()
    expect(artifactVerificationError({ status: 'checked', unknownFiles: [], revision: 'other' }, 'abc')).toContain('artifact_verification_unknown')
  })
})
