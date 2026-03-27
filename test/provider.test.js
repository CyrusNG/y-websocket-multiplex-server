import test from 'node:test'
import http from 'http'
import WebSocket from 'ws'
import * as Y from 'yjs'
import {
  cleanDoc,
  getDoc,
  getConnectionsForDoc,
  getDocsForConnection,
  setupWSConnection
} from '../src/utils.js'
import { MultiplexProvider } from '../src/provider.js'

/**
 * @param {() => boolean} predicate
 * @param {string} message
 * @param {number} timeoutMs
 */
const waitFor = async (predicate, message, timeoutMs = 3000) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(message)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * @param {string} namespace
 */
const createTestServer = async (namespace = 'ticket') => {
  let connectionCount = 0
  const sockets = new Set()
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('okay')
  })
  const wss = new WebSocket.Server({ noServer: true })

  wss.on('connection', (ws, request) => {
    connectionCount += 1
    sockets.add(ws)
    ws.on('close', () => {
      sockets.delete(ws)
    })
    setupWSConnection(namespace, ws, request)
  })

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request)
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address == null || typeof address === 'string') {
    throw new Error('Failed to acquire test server address')
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    getConnectionCount: () => connectionCount,
    getFirstSocket: () => sockets.values().next().value,
    close: async () => {
      sockets.forEach(socket => {
        socket.terminate()
      })
      await new Promise(resolve => wss.close(resolve))
      await new Promise(resolve => server.close(resolve))
    }
  }
}

/**
 * @param {string} value
 */
const createDocWithValue = value => {
  const doc = new Y.Doc()
  doc.getMap('data').set('value', value)
  return doc
}

/**
 * @param {Y.Doc} doc
 */
const getValue = doc => doc.getMap('data').get('value')

/**
 * @param {MultiplexProvider} provider
 */
const destroyProvider = async provider => {
  const ws = provider.wsManager.ws
  provider.destroy()
  if (ws !== null && typeof ws.terminate === 'function') {
    ws.terminate()
  }
  await new Promise(resolve => setTimeout(resolve, 20))
}

test('syncs a single routed doc over MultiplexProvider', async () => {
  const testServer = await createTestServer()

  const providerA = new MultiplexProvider(testServer.url, 'ticket', { WebSocketPolyfill: WebSocket })
  const providerB = new MultiplexProvider(testServer.url, 'ticket', { WebSocketPolyfill: WebSocket })

  const docA = new Y.Doc()
  const docB = new Y.Doc()

  const bindingA = providerA.attach('single-doc', docA, { disableBc: true })
  const bindingB = providerB.attach('single-doc', docB, { disableBc: true })

  await waitFor(() => bindingA.synced && bindingB.synced, 'Single doc bindings never synced')

  docA.getMap('data').set('value', 'hello')

  await waitFor(() => getValue(docB) === 'hello', 'Single doc update never reached the peer')

  await destroyProvider(providerA)
  await destroyProvider(providerB)
  await testServer.close()
})

test('scopes the same docName by namespace', async () => {
  const ticketServer = await createTestServer('ticket-a')
  const releaseServer = await createTestServer('ticket-b')

  const providerA = new MultiplexProvider(ticketServer.url, 'ticket-a', { WebSocketPolyfill: WebSocket })
  const providerB = new MultiplexProvider(releaseServer.url, 'ticket-b', { WebSocketPolyfill: WebSocket })

  const docA = new Y.Doc()
  const docB = new Y.Doc()

  const bindingA = providerA.attach('version', docA, { disableBc: true })
  const bindingB = providerB.attach('version', docB, { disableBc: true })

  await waitFor(() => bindingA.synced && bindingB.synced, 'Room-scoped bindings never synced')
  docA.getMap('data').set('value', 'ticket-a-value')

  await new Promise(resolve => setTimeout(resolve, 100))
  if (getValue(docB) !== undefined) {
    throw new Error('The same docName leaked across rooms')
  }

  if (getDoc('ticket-a', 'version') === undefined || getDoc('ticket-b', 'version') === undefined) {
    throw new Error('Room-scoped docs were not registered separately')
  }

  await destroyProvider(providerA)
  await destroyProvider(providerB)
  await ticketServer.close()
  await releaseServer.close()
})

test('shares one websocket across multiple routed docs', async () => {
  const testServer = await createTestServer()

  const providerA = new MultiplexProvider(testServer.url, 'ticket', { WebSocketPolyfill: WebSocket })
  const providerB = new MultiplexProvider(testServer.url, 'ticket', { WebSocketPolyfill: WebSocket })

  const docA1 = new Y.Doc()
  const docA2 = new Y.Doc()
  const docB1 = new Y.Doc()
  const docB2 = new Y.Doc()

  const bindingA1 = providerA.attach('doc-1', docA1, { disableBc: true })
  const bindingA2 = providerA.attach('doc-2', docA2, { disableBc: true })
  const bindingB1 = providerB.attach('doc-1', docB1, { disableBc: true })
  const bindingB2 = providerB.attach('doc-2', docB2, { disableBc: true })

  await waitFor(() => bindingA1.synced && bindingA2.synced && bindingB1.synced && bindingB2.synced, 'Multiplex bindings never synced')
  await waitFor(() => testServer.getConnectionCount() === 1, 'Expected one shared websocket for the same provider URL')

  docA1.getMap('data').set('value', 'alpha')
  docA2.getMap('data').set('value', 'beta')

  await waitFor(() => getValue(docB1) === 'alpha', 'doc-1 update never reached the peer')
  await waitFor(() => getValue(docB2) === 'beta', 'doc-2 update never reached the peer')

  await destroyProvider(providerA)
  await destroyProvider(providerB)
  await testServer.close()
})

test('exposes the shared physical websocket through getWebSocket()', async () => {
  const testServer = await createTestServer()

  const provider = new MultiplexProvider(testServer.url, 'ticket', { WebSocketPolyfill: WebSocket })
  const doc = new Y.Doc()
  const binding = provider.attach('doc-a', doc, { disableBc: true })

  await waitFor(() => binding.synced, 'Binding never synced')
  await waitFor(() => provider.getWebSocket() !== null, 'Provider never exposed the shared websocket')

  if (provider.getWebSocket() !== provider.wsManager.ws) {
    throw new Error('getWebSocket() did not return the current shared websocket')
  }

  await destroyProvider(provider)
  await testServer.close()
})

test('sends sync step 1 when attaching after the websocket is already open', async () => {
  const testServer = await createTestServer()

  const providerA = new MultiplexProvider(testServer.url, 'ticket', { WebSocketPolyfill: WebSocket })
  const providerB = new MultiplexProvider(testServer.url, 'ticket', { WebSocketPolyfill: WebSocket })

  const bootDocA = createDocWithValue('boot')
  const bootDocB = new Y.Doc()

  const bootBindingA = providerA.attach('boot-doc', bootDocA, { disableBc: true })
  const bootBindingB = providerB.attach('boot-doc', bootDocB, { disableBc: true })

  await waitFor(() => bootBindingA.synced && bootBindingB.synced, 'Boot bindings never synced')
  await waitFor(() => testServer.getConnectionCount() === 1, 'Expected the websocket to stay shared after the initial attach')

  const lateDocA = new Y.Doc()
  const lateDocB = new Y.Doc()

  const lateBindingA = providerA.attach('late-doc', lateDocA, { disableBc: true })
  const lateBindingB = providerB.attach('late-doc', lateDocB, { disableBc: true })

  await waitFor(() => lateBindingA.synced && lateBindingB.synced, 'Late bindings never synced after attach')

  lateDocA.getMap('data').set('value', 'late-update')

  await waitFor(() => getValue(lateDocB) === 'late-update', 'Late attached doc never synchronized')

  await destroyProvider(providerA)
  await destroyProvider(providerB)
  await testServer.close()
})

test('syncs routed docs across providers through BroadcastChannel when enabled', async () => {
  const providerA = new MultiplexProvider('ws://127.0.0.1:0', 'ticket', { connect: false, WebSocketPolyfill: WebSocket })
  const providerB = new MultiplexProvider('ws://127.0.0.1:0', 'ticket', { connect: false, WebSocketPolyfill: WebSocket })

  const docA = new Y.Doc()
  const docB = new Y.Doc()

  providerA.attach('bc-doc', docA)
  providerB.attach('bc-doc', docB)

  docA.getMap('data').set('value', 'from-broadcast-channel')

  await waitFor(() => getValue(docB) === 'from-broadcast-channel', 'BroadcastChannel sync never propagated the update')

  await destroyProvider(providerA)
  await destroyProvider(providerB)
})

test('exposes routed docs for a websocket connection and removes docs manually', async () => {
  const testServer = await createTestServer()

  const provider = new MultiplexProvider(testServer.url, 'ticket', { WebSocketPolyfill: WebSocket })
  const docA = new Y.Doc()
  const docB = new Y.Doc()

  const bindingA = provider.attach('doc-a', docA, { disableBc: true })
  const bindingB = provider.attach('doc-b', docB, { disableBc: true })

  await waitFor(() => bindingA.synced && bindingB.synced, 'Bindings never synced')

  const ws = testServer.getFirstSocket()
  await waitFor(() => ws !== undefined, 'Server websocket was never created')
  await waitFor(() => getDocsForConnection(ws).length === 2, 'Server never exposed both routed docs for the websocket')
  await waitFor(() => getConnectionsForDoc('ticket', 'doc-a').length === 1, 'Server never exposed the websocket for doc-a')

  const docNames = getDocsForConnection(ws).map(doc => doc.docName).sort()
  if (docNames.join(',') !== 'doc-a,doc-b') {
    throw new Error(`Unexpected routed doc names: ${docNames.join(',')}`)
  }

  if (getConnectionsForDoc('ticket', 'doc-a')[0] !== ws) {
    throw new Error('getConnectionsForDoc did not return the expected websocket')
  }

  if (!cleanDoc('ticket', 'doc-b')) {
    throw new Error('cleanDoc should return true for an existing doc')
  }

  await waitFor(() => getDoc('ticket', 'doc-b') === undefined, 'cleanDoc did not remove the doc from the server registry')
  await waitFor(() => getDocsForConnection(ws).length === 1, 'cleanDoc did not detach the doc from the websocket')
  await waitFor(() => getConnectionsForDoc('ticket', 'doc-b').length === 0, 'cleanDoc did not clear the doc connection registry')

  await destroyProvider(provider)
  await testServer.close()
})

test('automatically removes docs when the last connection closes', async () => {
  const testServer = await createTestServer()

  const provider = new MultiplexProvider(testServer.url, 'ticket', { WebSocketPolyfill: WebSocket })
  const doc = new Y.Doc()
  const binding = provider.attach('auto-cleanup-doc', doc, { disableBc: true })

  await waitFor(() => binding.synced, 'Binding never synced')
  await waitFor(() => getDoc('ticket', 'auto-cleanup-doc') !== undefined, 'Doc was never registered in the server registry')

  await destroyProvider(provider)
  await waitFor(() => getDoc('ticket', 'auto-cleanup-doc') === undefined, 'Doc was not removed after the last connection closed')
  await testServer.close()
})
