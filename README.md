# y-websocket-multiplex-server

A multiplex-first Yjs websocket server and client provider.

- One physical websocket can carry multiple routed Yjs docs (`docName`) in the same namespace.
- Works with awareness, optional BroadcastChannel sync, optional persistence, and optional NATS cluster sync.
- Compatible with the bundled CLI server (`y-websocket-multiplex-server`) and custom server wiring.

## Install

```sh
npm i y-multiplex-websocket-server yjs
```

## Quick Start

Start the bundled server:

```sh
HOST=localhost PORT=1234 npx y-websocket-multiplex-server
```

`PORT` defaults to `1234`, `HOST` defaults to `localhost`.

Client (single routed doc):

```js
import * as Y from 'yjs'
import { MultiplexProvider } from 'y-multiplex-websocket-server/multiplex-provider'

const doc = new Y.Doc()

const provider = new MultiplexProvider('ws://localhost:1234/connect/doc', 'ticket', {
  params: { token: 'demo-token' }
})

const binding = provider.attach('version', doc, { awareness: true })

binding.on('status', evt => {
  console.log(evt.status)
})
```

## Client API (MultiplexProvider)

`MultiplexProvider` is the supported client protocol.

```js
new MultiplexProvider(serverUrl, namespace, opts?)
```

- `serverUrl`: base websocket URL (example: `ws://localhost:1234/connect/doc`)
- `namespace`: logical namespace segment appended to the URL
- `opts.connect` (default `true`): provider-level auto connect
- `opts.params`: URL query params
- `opts.protocols`: websocket subprotocol(s)
- `opts.WebSocketPolyfill`: custom websocket constructor (Node/non-browser)
- `opts.maxBackoffTime` (default `10000`)

Attach docs:

```js
const binding = provider.attach(docName, ydoc, {
  awareness: true,     // false by default
  connect: true,
  disableBc: false,    // BroadcastChannel + localStorage fallback via lib0
  resyncInterval: -1   // ms; -1 disables periodic resubscribe
})
```

Useful methods:

- `provider.getWebSocket()` -> shared physical websocket (or `null` before connected)
- `provider.detach(docNameOrBinding)`
- `provider.connect()` / `provider.disconnect()`
- `provider.destroy()`
- `binding.connect()` / `binding.disconnect()` / `binding.destroy()`

Common binding events:

- `status` (`connected` / `disconnected`)
- `sync` (`boolean`)
- `connection-error`
- `connection-close`

## Namespace and docName

There are two levels:

- `namespace`: provider/server isolation scope
- `docName`: multiplex sub-route inside a namespace

If client does:

```js
provider.attach('version', doc)
```

under namespace `ticket`, server-side doc identity is `ticket + version`.

## Bundled Server

The package ships with a CLI runtime (`src/server.js`):

```sh
npx y-websocket-multiplex-server
```

It uses `setupWSConnection(...)` internally and serves a basic HTTP 200 health response.

## Custom Server Wiring

```js
import http from 'http'
import WebSocket from 'ws'
import { setupWSConnection } from 'y-multiplex-websocket-server/utils-connection'
import { getDoc, getConnectionsForDoc } from 'y-multiplex-websocket-server/utils-docs'

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('okay')
})

const wss = new WebSocket.Server({ noServer: true })

wss.on('connection', (ws, req) => {
  setupWSConnection('ticket', ws, req)

  const doc = getDoc('ticket', 'version')
  console.log(doc.docName)
  console.log(getConnectionsForDoc('ticket', 'version').length)
})

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req)
  })
})

server.listen(1234)
```

## Cluster Sync with NATS

This project includes server-to-server sync (`update`, `awareness`, and state-vector resync).

Use the convenience setup:

```js
import { setupYdocCluster } from 'y-multiplex-websocket-server/cluster'

setupYdocCluster({
  nodeId: 'node-a',
  nats: {
    connectOptions: {
      servers: ['nats://127.0.0.1:4222']
    }
  },
  resyncIntervalMs: 30000
})
```

Or via bundled server env:

```sh
NATS_SERVERS=nats://127.0.0.1:4222 NATS_NODE_ID=node-a npx y-websocket-multiplex-server
```

Environment variables:

- `NATS_SERVERS`: comma-separated servers
- `NATS_NODE_ID`: optional node id (defaults to `host:port:pid`)
- `NATS_RESYNC_INTERVAL`: periodic resync interval in ms (default `30000`)

### Host-managed membership (optional)

```js
import { setupYdocCluster } from 'y-multiplex-websocket-server/cluster'

const cluster = setupYdocCluster({
  nodeId: hostNodeId,
  nats: {
    connection: hostNatsConnection,
    subjectTemplate: {
      broadcast: 'myapp.ydoc.broadcast.{topic}.{doc}.{event}',
      unicast: 'myapp.ydoc.unicast.{nodeId}.{method}'
    }
  },
  chooseSyncNode: (docKey, aliveNodes, currentSyncNode) =>
    hostCluster.pickSyncNode(docKey, aliveNodes, currentSyncNode)
})

hostCluster.onMembershipChanged(({ aliveNodeIds, leaderNodeId, removedNodeIds }) => {
  cluster.setNodes(leaderNodeId, aliveNodeIds)
  removedNodeIds.forEach(nodeId => cluster.removeNode(nodeId))
})
```

Subject template validation:

- `broadcast` must include `{topic}`, `{doc}`, `{event}`
- `unicast` must include `{nodeId}`, `{method}`
- unknown tokens are rejected

## Persistence

Set persistence once at startup using `setPersistence(...)`:

```js
import { RedisPersistence } from 'y-redis'
import { setPersistence } from 'y-multiplex-websocket-server/utils-docs'

const redisPersistence = new RedisPersistence({
  redisOpts: { host: '127.0.0.1', port: 6379 }
})

setPersistence({
  bindState: async (docName, ydoc) => redisPersistence.bindState(docName, ydoc),
  unbindState: async (docName) => redisPersistence.closeDoc(docName)
})
```

Adapter shape:

- `bindState(name, doc)`
- `unbindState(name, doc)`

## HTTP Callback on Update

Debounced HTTP callback on document updates.

Environment variables:

- `CALLBACK_URL`
- `CALLBACK_DEBOUNCE_WAIT` (default `2000`)
- `CALLBACK_DEBOUNCE_MAXWAIT` (default `10000`)
- `CALLBACK_TIMEOUT` (default `5000`)
- `CALLBACK_OBJECTS` (JSON map of shared object name -> type)

Example:

```sh
CALLBACK_URL=http://localhost:3000/ \
CALLBACK_OBJECTS='{"prosemirror":"XmlFragment"}' \
npx y-websocket-multiplex-server
```

## Package Exports

- `y-multiplex-websocket-server/server`
- `y-multiplex-websocket-server/utils-docs`
- `y-multiplex-websocket-server/utils-connection`
- `y-multiplex-websocket-server/multiplex-provider`
- `y-multiplex-websocket-server/callback`
- `y-multiplex-websocket-server/cluster`

## License

[MIT](./LICENSE) © Cyrus NG
