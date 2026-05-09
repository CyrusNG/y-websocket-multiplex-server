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

It uses `setupWSConnection(...)` internally and serves a basic HTTP 200 health response.

Also, debounced HTTP callback on document updates.

Environment variables:

- `NATS_SERVERS`: comma-separated servers
- `NATS_NODE_ID`: optional node id (defaults to `host:port:pid`)
- `NATS_RESYNC_INTERVAL`: periodic resync interval in ms (default `30000`)
- `CALLBACK_URL`
- `CALLBACK_DEBOUNCE_WAIT` (default `2000`)
- `CALLBACK_DEBOUNCE_MAXWAIT` (default `10000`)
- `CALLBACK_TIMEOUT` (default `5000`)
- `CALLBACK_OBJECTS` (JSON map of shared object name -> type)

Example:

```sh
npx y-websocket-multiplex-server
```

```sh
CALLBACK_URL=http://localhost:3000/ \
CALLBACK_OBJECTS='{"prosemirror":"XmlFragment"}' \
npx y-websocket-multiplex-server
```

```sh
NATS_SERVERS=nats://127.0.0.1:4222 
NATS_NODE_ID=node-a 
npx y-websocket-multiplex-server
```


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

This project includes server-to-server ydoc sync feature.

Setup cluster mode when host project boot:

```js
import { setupYdocCluster } from 'y-multiplex-websocket-server/cluster'

  setupYdocCluster({
    nodeId: hostNodeId,
    nats: {
      connection: hostNatsConnection,
      subjectTemplate: {
        broadcast: 'myapp.ydoc.broadcast.{topic}.{channel}.{event}',
        unicast: 'myapp.ydoc.unicast.{nodeId}.{method}'
      }
    },
    chooseSyncNode: (docKey, aliveNodes, currentSyncNode) => host.pickSyncNode(docKey, aliveNodes, currentSyncNode)
  });

```

And host project pass cluster nodes changed info at its nodes changed event:

```js
import { getYdocCluster } from 'y-multiplex-websocket-server/cluster'

host.onMembershipChanged(({ aliveNodeIds, leaderNodeId, removedNodeIds }) => {
  const ydocCluster = getYdocCluster();
  if (!ydocCluster) return;
  removedNodeIds.forEach(nodeId => ydocCluster.removeNode(nodeId));
  ydocCluster.setNodes(leaderNodeId, aliveNodeIds);
})
```

### NATS Subjects and Methods

Logical names used by cluster sync:

- `doc.{namespace}-{docName}.update`
- `doc.{namespace}-{docName}.awareness`
- `doc.{namespace}-{docName}.anti-entropy`
- `bus.awareness.anti-entropy` (shared by awareness anti-entropy solicit + shard payloads)

Purpose of each logical name:

- `doc.{namespace}-{docName}.update`: broadcasts Yjs document updates between nodes.
- `doc.{namespace}-{docName}.awareness`: broadcasts real-time awareness deltas (presence/cursor/user state).
- `doc.{namespace}-{docName}.anti-entropy`: unicast request/reply method for document anti-entropy catch-up (state-vector diff pull).
- `bus.awareness.anti-entropy`: cluster-wide awareness anti-entropy bus; carries both solicitation signals and awareness shard payloads for reconciliation.

Default NATS subjects (without `subjectTemplate`):

- `broadcast.doc.{namespace}-{docName}.update`
- `broadcast.doc.{namespace}-{docName}.awareness`
- `unicast.doc.{nodeId}.{namespace}-{docName}.anti-entropy`
- `broadcast.bus.awareness.anti-entropy`

With `subjectTemplate` configured:

- `broadcast` template maps `{topic}.{channel}.{event}` from logical names
- `unicast` template maps `{nodeId}` + `{method}` where method is `doc.{namespace}-{docName}.anti-entropy`

Subject template validation:

- `broadcast` must include `{topic}`, `{channel}`, `{event}`
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

### Origin Conventions

`ydoc.on('update', (update, origin) => { ... })` forwards the Yjs `origin` value.

This project normalizes all update origins to a shared shape:

```js
origin = {
  source,
  meta: {
    docId,
    receivedAt,
    updateId
  }
}
```

To reliably receive the structured `{ source, meta }` origin in `ydoc.on('update')` for local changes, wrap local mutations in `doc.transact(...)`.
The transaction origin is then normalized by this project.

If you call `Y.applyUpdate(doc, update, origin)` directly, Yjs forwards that `origin` value as-is.
For example, `Y.applyUpdate(doc, update, 'persister')` will emit `'persister'` (not a structured origin object).
If you need structured origin on direct apply, pass an object origin explicitly.

`source` values by path:

- Cluster sync updates: `source: 'cluster'`
- Cluster catch-up updates: `source: 'catchup'`
- Websocket client sync updates: `source: 'client'`
- Local updates without explicit origin (`doc.transact(fn)`): `source: 'local'`
- Local updates with explicit origin (`doc.transact(fn, origin)`): `source` is set to the passed `origin` value as-is

Cluster mode keeps extra metadata in `meta`:

- `senderNodeId`
- `receiverNodeId`

Persistence guidance for host applications:

- Persist only business/live updates (for example `source: 'cluster'` and your local business sources).
- Do not persist `source: 'catchup'` updates.
- In other words, catch-up updates are transport diffs and should be ignored by persistence in the host project.

For example, you can use `source: 'replay_from_db'` when replaying persisted updates and skip re-persisting those updates in your adapter.



## Cluster Synchronous Mechanism

In cluster mode, we use NATS for synchronous, there are two sync paths running together:

- `ydoc` content sync
- `awareness` presence sync

Realtime broadcast timing:

- On local Yjs doc update, broadcast immediately to `doc.{namespace}-{docName}.update`.
- On local awareness change, broadcast immediately to `doc.{namespace}-{docName}.awareness`.

Anti-entropy timing:

- `ydoc` anti-entropy:
  - runs once in background after `bindDoc` (eager catch-up),
  - runs periodically when `resyncIntervalMs > 0`,
  - can be triggered by host via `resyncDoc` / `resyncAllDocs`.
- `awareness` anti-entropy:
  - runs after `bindDoc`,
  - runs periodically when `resyncIntervalMs > 0`,
  - runs again when `setNodes(...)` detects remote node join.

Host/runtime responsibility:

- Host is responsible for membership detection (alive nodes, removed nodes, optional sync node/leader).
- Host should push topology updates into this project by calling:
  - `setNodes(syncNode, aliveNodeIds)`
  - `removeNode(nodeId)` for explicit removals.

What this project does after host topology updates:

- removes awareness owned by down nodes,
- drops stale snapshots for removed nodes,
- runs awareness reconciliation when needed to converge presence state.


## Package Exports

- `y-multiplex-websocket-server/server`
- `y-multiplex-websocket-server/utils-docs`
- `y-multiplex-websocket-server/utils-connection`
- `y-multiplex-websocket-server/multiplex-provider`
- `y-multiplex-websocket-server/callback`
- `y-multiplex-websocket-server/cluster`

## License

[MIT](./LICENSE) © Cyrus NG