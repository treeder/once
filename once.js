let runs = new WeakMap()

/**
 * Ensures `func` runs once per isolate/process, sharing the in-flight or resolved
 * Promise across callers. If `func` throws or rejects, the cached entry is cleared
 * so subsequent calls can retry instead of permanently poisoning the isolate.
 *
 * @param {Function} func The function to execute once. Receives `c` as its argument.
 * @param {*} c Context passed into `func`.
 * @returns {Promise<*>}
 */
export async function once(func, c) {
  if (typeof func !== 'function') {
    throw new TypeError('once expects a function as the first argument')
  }
  let pending = runs.get(func)
  if (!pending) {
    console.log('once')
    pending = (async () => func(c))()
    runs.set(func, pending)
  }
  try {
    return await pending
  } catch (err) {
    if (runs.get(func) === pending) {
      runs.delete(func)
    }
    throw err
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
