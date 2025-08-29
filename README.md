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
