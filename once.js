let runs = new WeakMap()

const DEFAULT_INFLIGHT_TTL_MS = 30_000
const ABORTED_SENTINEL = Symbol('once.aborted')

function getSignal(c) {
  const signal = c?.request?.signal || c?.req?.raw?.signal || c?.signal || null
  return signal && typeof signal === 'object' && 'aborted' in signal ? signal : null
}

function toAbortError(signal) {
  return signal?.reason !== undefined
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
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

function waitForEntry(entry, callerSignal, ttlMs) {
  if (entry.aborted || entry.signal?.aborted) {
    return Promise.resolve(ABORTED_SENTINEL)
  }
  const remainingMs = Number.isFinite(ttlMs)
    ? Math.min(0x7fffffff, Math.max(0, ttlMs - (Date.now() - entry.startedAt)))
    : null
  if (remainingMs === 0) {
    return Promise.resolve(ABORTED_SENTINEL)
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let ttlTimer = null
    const cleanup = () => {
      if (ttlTimer !== null) {
        clearTimeout(ttlTimer)
        ttlTimer = null
      }
      entry.abortListeners.delete(finishAbort)
      if (callerSignal && typeof callerSignal.removeEventListener === 'function') {
        try {
          callerSignal.removeEventListener('abort', finishAbort)
        } catch {}
      }
    }
    const finishAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(ABORTED_SENTINEL)
    }

    entry.abortListeners.add(finishAbort)
    if (callerSignal && typeof callerSignal.addEventListener === 'function') {
      if (callerSignal.aborted) {
        finishAbort()
        return
      }
      callerSignal.addEventListener('abort', finishAbort, { once: true })
    }

    if (remainingMs !== null) {
      ttlTimer = setTimeout(() => {
        ttlTimer = null
        finishAbort()
      }, remainingMs)
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
      const outcome = await waitForEntry(entry, callerSignal, ttlMs)
      if (outcome === ABORTED_SENTINEL) {
        if (callerSignal?.aborted) {
          throw toAbortError(callerSignal)
        }
        continue
      }
      return outcome
    }

    const signal = getSignal(c)
    if (signal?.aborted) {
      throw toAbortError(signal)
    }

    const current = {
      done: false,
      promise: null,
      signal,
      aborted: false,
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

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    runs.set(func, current)

    console.log('once')
    current.promise = (async () => {
      try {
        const value = await func(c)
        if (runs.get(func) === current && !current.aborted) {
          runs.set(func, { done: true, value })
        }
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

    if (!signal) {
      return await current.promise
    }

    current.promise.catch(() => {})
    const outcome = await waitForEntry(current, null, Infinity)
    if (outcome === ABORTED_SENTINEL) {
      throw toAbortError(signal)
    }
    return outcome
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
