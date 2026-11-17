let runs = new WeakMap()

const DEFAULT_INFLIGHT_TTL_MS = 30_000
const ABORTED_SENTINEL = Symbol('once.aborted')

function getSignal(c) {
  const signal = c?.request?.signal || c?.req?.raw?.signal || c?.signal || null
  return signal && typeof signal === 'object' && 'aborted' in signal ? signal : null
}

function getWaitUntil(c) {
  if (typeof c?.waitUntil === 'function') return c.waitUntil.bind(c)
  if (typeof c?.executionCtx?.waitUntil === 'function') return c.executionCtx.waitUntil.bind(c.executionCtx)
  if (typeof c?.ctx?.waitUntil === 'function') return c.ctx.waitUntil.bind(c.ctx)
  return null
}

function isStaleEntry(entry, ttlMs) {
  if (!entry || entry.done) return false
  if (entry.aborted || entry.signal?.aborted) return true
  if (Date.now() - entry.startedAt >= ttlMs) return true
  return false
}

function waitForEntry(entry, callerSignal) {
  if (entry.aborted || entry.signal?.aborted) {
    return Promise.resolve(ABORTED_SENTINEL)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      entry.abortListeners.delete(onCreatorAbort)
      if (callerSignal && typeof callerSignal.removeEventListener === 'function') {
        try {
          callerSignal.removeEventListener('abort', onCallerAbort)
        } catch {}
      }
    }
    const onCreatorAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(ABORTED_SENTINEL)
    }
    const onCallerAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(ABORTED_SENTINEL)
    }

    entry.abortListeners.add(onCreatorAbort)
    if (callerSignal && typeof callerSignal.addEventListener === 'function') {
      if (callerSignal.aborted) {
        onCallerAbort()
        return
      }
      callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }

    entry.promise.then(
      (val) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(val)
      },
      (err) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      },
    )
  })
}

/**
 * Ensures `func` runs once per isolate/process without retaining cross-request
 * Promises after completion or stranding subsequent requests on unsettled Promises
 * from aborted/ended Cloudflare Workers requests.
 *
 * - Once `func` resolves, stores `{ done: true, value }` so warm calls return
 *   immediately in their own request context without awaiting a prior request's Promise.
 * - Registers in-flight execution with `c.waitUntil` (or `c.executionCtx.waitUntil` /
 *   `c.ctx.waitUntil`) when available so early client disconnects do not cancel cold-start work.
 * - Evicts in-flight state on rejection, request `AbortSignal` abort, or staleness past
 *   `inFlightTtlMs` (default 30s) so dead unsettled Promises never poison the isolate.
 *
 * @param {Function} func The function to execute once. Receives `c` as its argument.
 * @param {*} [c] Context passed into `func`.
 * @param {{ inFlightTtlMs?: number }} [options]
 * @returns {Promise<*>}
 */
export async function once(func, c, options) {
  if (typeof func !== 'function') {
    throw new TypeError('once expects a function as the first argument')
  }

  const ttlMs =
    typeof options?.inFlightTtlMs === 'number' && options.inFlightTtlMs > 0
      ? options.inFlightTtlMs
      : DEFAULT_INFLIGHT_TTL_MS

  while (true) {
    let entry = runs.get(func)
    if (entry?.done) {
      return entry.value
    }

    if (entry && isStaleEntry(entry, ttlMs)) {
      runs.delete(func)
      entry = undefined
    }

    if (entry) {
      const callerSignal = getSignal(c)
      const outcome = await waitForEntry(entry, callerSignal)
      if (outcome === ABORTED_SENTINEL) {
        if (callerSignal?.aborted) {
          throw callerSignal.reason || new DOMException('The operation was aborted.', 'AbortError')
        }
        continue
      }
      return outcome
    }

    const signal = getSignal(c)
    const current = {
      done: false,
      promise: null,
      signal,
      aborted: Boolean(signal?.aborted),
      startedAt: Date.now(),
      abortListeners: new Set(),
    }

    const onAbort = () => {
      current.aborted = true
      if (runs.get(func) === current) {
        runs.delete(func)
      }
      const listeners = Array.from(current.abortListeners)
      current.abortListeners.clear()
      for (const notify of listeners) {
        notify()
      }
    }

    if (signal && !signal.aborted && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    if (!current.aborted) {
      runs.set(func, current)
    }

    console.log('once')
    current.promise = (async () => {
      try {
        const value = await func(c)
        runs.set(func, { done: true, value })
        return value
      } catch (err) {
        if (runs.get(func) === current) {
          runs.delete(func)
        }
        throw err
      } finally {
        current.abortListeners.clear()
        if (signal && typeof signal.removeEventListener === 'function') {
          try {
            signal.removeEventListener('abort', onAbort)
          } catch {}
        }
      }
    })()

    const waitUntil = getWaitUntil(c)
    if (waitUntil) {
      try {
        waitUntil(current.promise.catch(() => {}))
      } catch {}
    }

    return await current.promise
  }
}

/**
 * Clears cached execution state for a specific function, or all functions when omitted.
 *
 * @param {Function} [func]
 */
export function resetOnce(func) {
  if (func) {
    runs.delete(func)
  } else {
    runs = new WeakMap()
  }
}
