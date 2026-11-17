import test from 'node:test'
import assert from 'node:assert/strict'
import { once, resetOnce } from '../once.js'

test('executes function once and shares result across sequential and concurrent calls', async () => {
  resetOnce()
  let count = 0
  const init = async (c) => {
    count++
    await new Promise((r) => setTimeout(r, 10))
    return `ok:${c.id}`
  }

  const [r1, r2] = await Promise.all([once(init, { id: 1 }), once(init, { id: 2 })])
  const r3 = await once(init, { id: 3 })

  assert.equal(count, 1)
  assert.equal(r1, 'ok:1')
  assert.equal(r2, 'ok:1')
  assert.equal(r3, 'ok:1')
})

test('clears cached promise on async rejection (including concurrent callers) so subsequent calls retry cleanly', async () => {
  resetOnce()
  let attempts = 0
  const flakyInit = async () => {
    attempts++
    await new Promise((r) => setTimeout(r, 5))
    if (attempts === 1) {
      throw new Error('D1_ERROR: internal error')
    }
    return 'recovered'
  }

  const results = await Promise.allSettled([once(flakyInit, {}), once(flakyInit, {})])
  assert.equal(attempts, 1)
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'rejected')

  const res = await once(flakyInit, {})
  assert.equal(res, 'recovered')
  assert.equal(attempts, 2)

  // Subsequent calls stay cached after recovery
  const res2 = await once(flakyInit, {})
  assert.equal(res2, 'recovered')
  assert.equal(attempts, 2)
})

test('clears cached promise on synchronous throw', async () => {
  resetOnce()
  let attempts = 0
  const syncFlaky = () => {
    attempts++
    if (attempts === 1) {
      throw new Error('sync boom')
    }
    return 42
  }

  await assert.rejects(() => once(syncFlaky, {}), /sync boom/)
  assert.equal(await once(syncFlaky, {}), 42)
  assert.equal(attempts, 2)
})

test('tracks distinct functions independently', async () => {
  resetOnce()
  let aCount = 0
  let bCount = 0
  const fnA = async () => ++aCount && 'A'
  const fnB = async () => ++bCount && 'B'

  assert.equal(await once(fnA), 'A')
  assert.equal(await once(fnB), 'B')
  assert.equal(await once(fnA), 'A')
  assert.equal(await once(fnB), 'B')
  assert.equal(aCount, 1)
  assert.equal(bCount, 1)
})

test('evicts unsettled promise when initial request aborts so subsequent requests never hang', async () => {
  resetOnce()
  let calls = 0
  const init = async (c) => {
    calls++
    if (calls === 1) {
      // Simulate Cloudflare Workers request IoContext ending without ever settling its pending promises
      return await new Promise(() => {})
    }
    return `ready:${c.id}`
  }

  const ac1 = new AbortController()
  const c1 = { id: 1, request: { signal: ac1.signal } }
  // Start Request 1 and abort mid-flight
  void once(init, c1)
  ac1.abort()

  const c2 = { id: 2, request: { signal: new AbortController().signal } }
  const res = await once(init, c2)
  assert.equal(res, 'ready:2')
  assert.equal(calls, 2)

  // Subsequent warm calls return cached value without re-running
  assert.equal(await once(init, { id: 3 }), 'ready:2')
  assert.equal(calls, 2)
})

test('concurrent caller detaches and succeeds in its own context if initiating request aborts mid-flight', async () => {
  resetOnce()
  let calls = 0
  const init = async (c) => {
    calls++
    if (c.id === 1) {
      return await new Promise(() => {})
    }
    await new Promise((r) => setTimeout(r, 5))
    return `from:${c.id}`
  }

  const ac1 = new AbortController()
  const c1 = { id: 1, request: { signal: ac1.signal } }
  const c2 = { id: 2, request: { signal: new AbortController().signal } }

  void once(init, c1)
  const p2 = once(init, c2)

  setTimeout(() => ac1.abort(), 5)
  const res2 = await p2
  assert.equal(res2, 'from:2')
  assert.equal(calls, 2)
})

test('registers waitUntil and swallows rejections on waitUntil promise', async () => {
  resetOnce()
  const waitUntilPromises = []
  const c = {
    waitUntil: (p) => waitUntilPromises.push(p),
  }

  await assert.rejects(
    () =>
      once(async () => {
        throw new Error('transient failure')
      }, c),
    /transient failure/,
  )

  assert.equal(waitUntilPromises.length, 1)
  await assert.doesNotReject(() => Promise.all(waitUntilPromises))
})

test('evicts stale unsettled in-flight promise after inFlightTtlMs when no AbortSignal is present', async () => {
  resetOnce()
  let calls = 0
  const init = async () => {
    calls++
    if (calls === 1) {
      return await new Promise(() => {})
    }
    return 'recovered-after-ttl'
  }

  void once(init, {}, { inFlightTtlMs: 15 })
  await new Promise((r) => setTimeout(r, 25))

  const res = await once(init, {}, { inFlightTtlMs: 15 })
  assert.equal(res, 'recovered-after-ttl')
  assert.equal(calls, 2)
})
