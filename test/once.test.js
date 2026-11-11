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

test('clears cached promise on async rejection so subsequent calls retry cleanly', async () => {
  resetOnce()
  let attempts = 0
  const flakyInit = async () => {
    attempts++
    if (attempts === 1) {
      throw new Error('D1_ERROR: internal error')
    }
    return 'recovered'
  }

  await assert.rejects(() => once(flakyInit, {}), /D1_ERROR: internal error/)
  assert.equal(attempts, 1)

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
