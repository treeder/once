# once

A simple once function to ensure something runs only one time. 

```sh
npm install treeder/once
```

Or in the browser:

```js
import {once} from 'https://cdn.jsdelivr.net/gh/treeder/once@1/once.js'
```

Then use it like this:

```js
function myFunc(c){
  console.log('myFunc:', c.data)
}

// no matter how many times you call this, myFunc will only run once.
await once(myFunc, {data: {'abc': 123}})
```

## Request Contexts & Options

When `c` is a request/framework context (such as Cloudflare Workers or Hono), `once` automatically:
- Registers in-flight execution with `c.waitUntil` (`c.executionCtx.waitUntil` / `c.ctx.waitUntil`) when available.
- Evicts unsettled in-flight runs if the request's `AbortSignal` (`c.request.signal` / `c.req.raw.signal` / `c.signal`) aborts or exceeds `inFlightTtlMs` (default `30000`ms), preventing hung cold-start promises from stranding subsequent requests.
- Caches resolved values directly rather than retaining cross-request `Promise`s.

```js
import { once, resetOnce } from 'once'

await once(initDb, c, { inFlightTtlMs: 15_000 })

// Clear cached state for a specific function (or all functions when omitted):
resetOnce(initDb)
```
