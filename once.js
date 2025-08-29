
let finished

/**
 * 
 * @param {*} func the function that will be executed once and only once. It should accept one argument: the context.
 * @param {*} c the context that will be passed into the function.
 * Include any data or things that the function needs to operate.
 * @returns a Promise
 */
export async function once(func, c) {
  if (finished) return finished
  console.log('once')
  finished = func(c)
  return finished
}