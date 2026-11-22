import { describe, expect, it, vi } from 'vitest'
import type { WeComQrAuthPollResult } from '@/stores/channels-types'
import {
  interpretWecomQrPoll,
  pollWecomQrUntilDone,
  redactSaveError,
} from '../wecom-qr-session'

const ready = (over: Partial<WeComQrAuthPollResult> = {}): WeComQrAuthPollResult => ({
  status: 'success',
  botId: 'bot-1',
  secret: 'qr-test-secret-value',
  ...over,
})

describe('interpretWecomQrPoll', () => {
  it('accepts success only when both credentials are non-empty', () => {
    expect(interpretWecomQrPoll(ready())).toEqual({
      type: 'ready',
      botId: 'bot-1',
      secret: 'qr-test-secret-value',
    })
  })

  it('keeps polling when success is missing a secret or a bot id', () => {
    expect(interpretWecomQrPoll(ready({ secret: '  ' }))).toEqual({ type: 'pending', phase: 'waiting' })
    expect(interpretWecomQrPoll(ready({ botId: '' }))).toEqual({ type: 'pending', phase: 'waiting' })
    expect(interpretWecomQrPoll({ status: 'success' })).toEqual({ type: 'pending', phase: 'waiting' })
  })

  it('treats scanned spellings as still pending', () => {
    expect(interpretWecomQrPoll({ status: 'scanned', botId: 'bot-1', secret: 'x' })).toEqual({
      type: 'pending',
      phase: 'scanned',
    })
    expect(interpretWecomQrPoll({ status: 'scaned' })).toEqual({ type: 'pending', phase: 'scanned' })
  })

  it('stops on expired', () => {
    expect(interpretWecomQrPoll({ status: 'expired', botId: 'bot-1', secret: 'x' })).toEqual({
      type: 'expired',
    })
  })
})

describe('pollWecomQrUntilDone', () => {
  const noSleep = async () => {}

  it('continues through incomplete success and scanned, then returns the full credential', async () => {
    const script: WeComQrAuthPollResult[] = [
      { status: 'success', botId: 'bot-1' },
      { status: 'scaned' },
      { status: 'success', botId: 'bot-1', secret: '' },
      { status: 'success', botId: 'bot-1', secret: 'qr-test-secret-value' },
    ]
    const poll = vi.fn(async () => script.shift()!)
    const phases: string[] = []
    const outcome = await pollWecomQrUntilDone({
      poll,
      signal: new AbortController().signal,
      sleep: noSleep,
      now: () => 0,
      deadlineMs: 10_000,
      onPending: (phase) => phases.push(phase),
    })
    expect(outcome).toEqual({ type: 'ready', botId: 'bot-1', secret: 'qr-test-secret-value' })
    expect(poll).toHaveBeenCalledTimes(4)
    expect(phases).toEqual(['waiting', 'scanned', 'waiting'])
  })

  it('does not start a second poll while the first is in flight', async () => {
    let release: (value: WeComQrAuthPollResult) => void = () => {}
    let entered = 0
    const poll = vi.fn(
      () =>
        new Promise<WeComQrAuthPollResult>((resolve) => {
          entered += 1
          release = resolve
        }),
    )
    const controller = new AbortController()
    const pending = pollWecomQrUntilDone({
      poll,
      signal: controller.signal,
      sleep: noSleep,
      now: () => 0,
      deadlineMs: 10_000,
    })
    await vi.waitFor(() => expect(entered).toBe(1))
    expect(poll).toHaveBeenCalledTimes(1)
    release({ status: 'expired' })
    await expect(pending).resolves.toEqual({ type: 'expired' })
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('drops a success that arrives after abort', async () => {
    let release: (value: WeComQrAuthPollResult) => void = () => {}
    const poll = vi.fn(
      () =>
        new Promise<WeComQrAuthPollResult>((resolve) => {
          release = resolve
        }),
    )
    const controller = new AbortController()
    const pending = pollWecomQrUntilDone({
      poll,
      signal: controller.signal,
      sleep: noSleep,
      now: () => 0,
      deadlineMs: 10_000,
    })
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1))
    controller.abort()
    release({ status: 'success', botId: 'bot-1', secret: 'qr-test-secret-value' })
    await expect(pending).resolves.toEqual({ type: 'aborted' })
  })

  it('stops after consecutive transport errors and on timeout', async () => {
    const poll = vi.fn(async () => {
      throw new Error('pipe busy')
    })
    const errored = await pollWecomQrUntilDone({
      poll,
      signal: new AbortController().signal,
      sleep: noSleep,
      now: () => 0,
      deadlineMs: 10_000,
      maxConsecutiveErrors: 3,
    })
    expect(errored).toEqual({ type: 'error' })
    expect(poll).toHaveBeenCalledTimes(3)

    let clock = 0
    const timed = await pollWecomQrUntilDone({
      poll: async () => ({ status: 'waiting' }),
      signal: new AbortController().signal,
      sleep: async () => {
        clock += 1000
      },
      now: () => clock,
      deadlineMs: 2500,
    })
    expect(timed).toEqual({ type: 'timeout' })
  })
})

describe('redactSaveError', () => {
  it('strips the secret and any url from a save failure', () => {
    const secret = 'qr-test-secret-value'
    const text = redactSaveError(
      new Error(`save failed for ${secret} at https://work.weixin.qq.com/ai/qc/query_result?scode=abc`),
      secret,
    )
    expect(text).not.toContain(secret)
    expect(text).not.toContain('scode')
    expect(text).not.toContain('https://')
    expect(text).toContain('[redacted]')
    expect(text).toContain('[url]')
  })
})
