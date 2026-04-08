
# y-websocket-server :tophat:
> Simple backend for [y-websocket](https://github.com/yjs/y-websocket)

The Websocket Provider is a solid choice if you want a central source that
handles authentication and authorization. Websockets also send header
information and cookies, so you can use existing authentication mechanisms with
this server.

## Quick Start

### Install dependencies

```sh
npm i @y/websocket-server
```

### Start a y-websocket server

This repository implements a basic server that you can adopt to your specific use-case. [(source code)](./src/)

Start a y-websocket server:

```sh
HOST=localhost PORT=1234 npx y-websocket
```

### Client Code

Single routed doc:

```js
import * as Y from 'yjs'
import { MultiplexProvider } from '@y/websocket-server/provider'

const doc = new Y.Doc()

const multiplexProvider = new MultiplexProvider(
  'ws://localhost:1234/connect/doc',
  'ticket',
  {
    params: {
      token: 'demo-token'
    }
  }
)

const binding = multiplexProvider.attach('version', doc)

binding.on('status', event => {
  console.log(event.status)
})
```

Multiple routed docs on one websocket:

```js
import * as Y from 'yjs'
import { MultiplexProvider } from '@y/websocket-server/provider'

const docA = new Y.Doc()
const docB = new Y.Doc()

const multiplexProvider = new MultiplexProvider(
  'ws://localhost:1234/connect/doc',
  'ticket'
)

const providerA = multiplexProvider.attach('doc-a', docA)
const providerB = multiplexProvider.attach('doc-b', docB)

providerA.on('status', event => {
  console.log('doc-a', event.status)
})

providerB.on('status', event => {
  console.log('doc-b', event.status)
})

multiplexProvider.detach('doc-b')
```

`MultiplexProvider` is the only supported client protocol. It builds the final websocket URL from `serverUrl`, `namespace`, and `opts`, and automatically appends `multiplex=true` to the query string.

Connection-level options such as `connect`, `params`, `protocols`, `WebSocketPolyfill`, and `maxBackoffTime` belong on `new MultiplexProvider(...)`.
Doc-level options such as `awareness`, `connect`, `resyncInterval`, and `disableBc` belong on `attach(...)`.
When `disableBc` is `false`, routed docs also sync across browser tabs using `BroadcastChannel` with a localStorage fallback from `lib0`.

The client `namespace`, server `namespace`, and routed `docName` are different:

- The client `namespace` belongs to `new MultiplexProvider(serverUrl, namespace, ...)` and is used to build the websocket URL
- The server `namespace` belongs to `setupWSConnection(namespace, ws, req, ...)` and is the server-side isolation boundary
- `docName` belongs to `attach(docName, doc, ...)` and is scoped inside that server-side namespace

If you need the shared physical websocket on the client, call `multiplexProvider.getWebSocket()`. It returns `null` before the websocket is connected.

On the server, call `getDoc(namespace, docName)` with the same namespace passed to `setupWSConnection(...)` and the same `docName` string used in `attach(...)`. If the doc does not exist yet, `getDoc(...)` creates it.

## Websocket Server

Start a y-websocket server:

```sh
HOST=localhost PORT=1234 npx y-websocket
```

Since npm symlinks the `y-websocket` executable from your local `./node_modules/.bin` folder, you can simply run npx. The `PORT` environment variable already defaults to 1234, and `HOST` defaults to `localhost`.

### Custom Server Code

```js
import http from 'http'
import WebSocket from 'ws'
import {
  cleanDoc,
  getDoc,
  getConnectionsForDoc,
  getDocsForConnection,
  setupWSConnection
} from '@y/websocket-server/utils'

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain' })
  response.end('okay')
})

const wss = new WebSocket.Server({ noServer: true })

wss.on('connection', (ws, request) => {
  setupWSConnection('ticket', ws, request)

  // The current routed docs for this websocket connection.
  console.log(getDocsForConnection(ws).map(doc => ({
    namespace: doc.namespace,
    docName: doc.docName
  })))

  // Access or create a routed doc by namespace + attach(docName, doc).
  console.log(getDoc('ticket', 'version'))

  // List the websocket connections currently attached to a routed doc.
  console.log(getConnectionsForDoc('ticket', 'version'))

  // Clean the current in-memory doc instance for a routed doc when needed.
  cleanDoc('ticket', 'version')
})

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request)
  })
})

server.listen(1234)
```

The server always speaks the routed multiplex protocol. A single doc connection is simply a multiplex connection with one attached route.
When the last connection for a doc closes, that doc is automatically destroyed and removed from the server-side doc registry.

### Multiplex End-to-End Example

Server:

```js
import http from 'http'
import WebSocket from 'ws'
import { setupWSConnection } from '@y/websocket-server/utils'

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain' })
  response.end('okay')
})

const wss = new WebSocket.Server({ noServer: true })

wss.on('connection', (ws, request) => {
  setupWSConnection('ticket', ws, request)
})

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request)
  })
})

server.listen(1234, () => {
  console.log('server listening on ws://localhost:1234')
})
```

Client:

```js
import * as Y from 'yjs'
import { MultiplexProvider } from '@y/websocket-server/provider'

const multiplexProvider = new MultiplexProvider(
  'ws://localhost:1234/connect/doc',
  'ticket',
  {
    params: {
      token: 'demo-token'
    }
  }
)

const editorDoc = new Y.Doc()
const commentDoc = new Y.Doc()

const editorBinding = multiplexProvider.attach('page:1:editor', editorDoc)
const commentBinding = multiplexProvider.attach('page:1:comments', commentDoc, {
  resyncInterval: 5000,
  disableBc: true
})

editorBinding.on('status', event => {
  console.log('editor', event.status)
})

commentBinding.on('status', event => {
  console.log('comments', event.status)
})

editorBinding.on('sync', isSynced => {
  console.log('editor synced:', isSynced)
})

commentBinding.on('sync', isSynced => {
  console.log('comments synced:', isSynced)
})

// Remove a single routed doc while keeping the shared socket alive
// for the other attached docs.
commentBinding.destroy()

// Close the whole multiplex provider when no routed docs are needed.
multiplexProvider.destroy()
```

In this example, `/connect/doc/ticket` remains available for application routing or authorization, while `page:1:editor` and `page:1:comments` are multiplex sub-routes that share one websocket connection and keep independent Y.Doc sync and awareness state.

If you only need one doc, attach exactly one route and use it the same way.

For example, if the client calls `attach('version', doc)`, the server should read that doc with `getDoc('ticket', 'version')`.

### Websocket Server with Persistence

This project supports injecting a persistence adapter in `setupWSConnection(...)`, similar to `y-websocket-server`.

With `y-redis`:

```js
import { RedisPersistence } from 'y-redis'
import { setupWSConnection } from '@y/websocket-server/utils'

const redisPersistence = new RedisPersistence({
  redisOpts: { host: '127.0.0.1', port: 6379 }
})

const persistence = {
  bindState: async (docName, ydoc) => await redisPersistence.bindState(docName, ydoc),
  unbindState: async (docName, ydoc) => await redisPersistence.closeDoc(docName)
}

wss.on('connection', (ws, request) => {
  setupWSConnection('ticket', ws, request, { persistence })
})
```

`setupWSConnection` accepts:

* A persistence adapter object with `{ bindState, unbindState }`

Note: this multiplex server manages docs by `namespace + docName` routes, so it does not use a single `doc` option like single-document servers.

### Websocket Server with HTTP callback

Send a debounced callback to an HTTP server (`POST`) on document update. Note that this implementation doesn't implement a retry logic in case the `CALLBACK_URL` does not work.

Can take the following ENV variables:

* `CALLBACK_URL` : Callback server URL
* `CALLBACK_DEBOUNCE_WAIT` : Debounce time between callbacks (in ms). Defaults to 2000 ms
* `CALLBACK_DEBOUNCE_MAXWAIT` : Maximum time to wait before callback. Defaults to 10 seconds
* `CALLBACK_TIMEOUT` : Timeout for the HTTP call. Defaults to 5 seconds
* `CALLBACK_OBJECTS` : JSON of shared objects to get data (`'{"SHARED_OBJECT_NAME":"SHARED_OBJECT_TYPE}'`)

```sh
CALLBACK_URL=http://localhost:3000/ CALLBACK_OBJECTS='{"prosemirror":"XmlFragment"}' npm start
```
This sends a debounced callback to `localhost:3000` 2 seconds after receiving an update (default `DEBOUNCE_WAIT`) with the data of an XmlFragment named `"prosemirror"` in the body.

## License

[The MIT License](./LICENSE) © Kevin Jahns
