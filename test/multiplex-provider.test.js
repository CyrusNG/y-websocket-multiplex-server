import test from 'node:test'
import http from 'http'
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as awarenessProtocol from '@y/protocols/awareness'
import {
  cleanDoc,
  getDoc,
  getConnectionsForDoc,
  getDocsForConnection
} from '../src/utils-docs.js'
import { setupWSConnection } from '../src/utils-connection.js'
import { MultiplexProvider } from '../src/multiplex-provider.js'

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
 * @param {() => boolean} predicate
 * @param {string} message
 * @param {number} durationMs
 */
const expectForDuration = async (predicate, message, durationMs = 1000) => {
  const start = Date.now()
  while (Date.now() - start < durationMs) {
    if (!predicate()) {
      throw new Error(message)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const presenceTimeoutMs = 1000

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

/**
 * @param {import('../src/multiplex-provider.js').MultiplexBinding} binding
 * @returns {Array<number>}
 */
const getAwarenessClients = binding => binding.awareness === null ? [] : Array.from(binding.awareness.getStates().keys())

/**
 * @param {import('../src/multiplex-provider.js').MultiplexBinding} binding
 * @param {Y.Doc} docA
 * @param {Y.Doc} docB
 * @param {Array<'A'|'B'>} expected
 * @returns {boolean}
 */
const awarenessMatches = (binding, docA, docB, expected) => {
  const clients = getAwarenessClients(binding)
  const expectedIds = expected.map(label => label === 'A' ? docA.clientID : docB.clientID)
  if (clients.length !== expectedIds.length) {
    return false
  }
  return expectedIds.every(id => clients.includes(id))
}

/**
 * @param {{
 *   bindingA: import('../src/multiplex-provider.js').MultiplexBinding,
 *   bindingB: import('../src/multiplex-provider.js').MultiplexBinding,
 *   docA: Y.Doc,
 *   docB: Y.Doc
 * }} context
 * @param {Array<'A'|'B'>} expectedA
 * @param {Array<'A'|'B'>} expectedB
 * @param {string} message
 */
const waitForAwarenessState = async (context, expectedA, expectedB, message) => {
  const { bindingA, bindingB, docA, docB } = context
  await waitFor(
    () => awarenessMatches(bindingA, docA, docB, expectedA) && awarenessMatches(bindingB, docA, docB, expectedB),
    message,
    presenceTimeoutMs
  )
}

/**
 * @param {string} step
 * @param {{
 *   bindingA: import('../src/multiplex-provider.js').MultiplexBinding,
 *   bindingB: import('../src/multiplex-provider.js').MultiplexBinding
 * }} context
 */
const applyPresenceStep = async (step, context) => {
  const { bindingA, bindingB, docA, docB } = context
  switch (step) {
    case 'A_DOWN':
      bindingA.disconnect()
      await waitFor(() => awarenessMatches(bindingA, docA, docB, []), 'Client A did not become empty after A_DOWN', presenceTimeoutMs)
      if (bindingB.isActive()) {
        await waitFor(() => awarenessMatches(bindingB, docA, docB, ['B']), 'Client B did not keep only itself after A_DOWN', presenceTimeoutMs)
      }
      break
    case 'B_DOWN':
      bindingB.disconnect()
      await waitFor(() => awarenessMatches(bindingB, docA, docB, []), 'Client B did not become empty after B_DOWN', presenceTimeoutMs)
      if (bindingA.isActive()) {
        await waitFor(() => awarenessMatches(bindingA, docA, docB, ['A']), 'Client A did not keep only itself after B_DOWN', presenceTimeoutMs)
      }
      break
    case 'A_UP':
      bindingA.connect()
      await waitFor(() => bindingA.synced, 'Client A did not resync after A_UP', presenceTimeoutMs)
      break
    case 'B_UP':
      bindingB.connect()
      await waitFor(() => bindingB.synced, 'Client B did not resync after B_UP', presenceTimeoutMs)
      break
    default:
      throw new Error(`Unknown presence step: ${step}`)
  }
}

/**
 * @param {{
 *   steps: Array<string>,
 *   expectedA: Array<'A'|'B'>,
 *   expectedB: Array<'A'|'B'>,
 *   expectationMessage: string
 * }} scenario
 */
const runPresenceScenario = async scenario => {
  const testServer = await createTestServer()
  const providerA = new MultiplexProvider(testServer.url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { client: 'a' }
  })
  const providerB = new MultiplexProvider(testServer.url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { client: 'b' }
  })
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const bindingA = providerA.attach('presence-doc', docA, { disableBc: true, awareness: true })
  const bindingB = providerB.attach('presence-doc', docB, { disableBc: true, awareness: true })
  try {
    await waitFor(() => bindingA.synced && bindingB.synced, 'Presence bindings never synced')
    bindingA.awareness.setLocalStateField('user', 'alice')
    bindingB.awareness.setLocalStateField('user', 'bob')
    await waitFor(
      () => awarenessMatches(bindingA, docA, docB, ['A', 'B']) && awarenessMatches(bindingB, docA, docB, ['A', 'B']),
      'Initial awareness exchange did not complete',
      presenceTimeoutMs
    )

    const context = { bindingA, bindingB, docA, docB }
    for (const step of scenario.steps) {
      await applyPresenceStep(step, context)
    }

    await waitForAwarenessState(context, scenario.expectedA, scenario.expectedB, scenario.expectationMessage)
  } finally {
    await destroyProvider(providerA)
    await destroyProvider(providerB)
    await testServer.close()
  }
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

  if (getDoc('ticket-a', 'version') == null || getDoc('ticket-b', 'version') == null) {
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

test('does not create awareness by default when attaching', () => {
  const provider = new MultiplexProvider('ws://127.0.0.1:1234', 'ticket', {
    WebSocketPolyfill: WebSocket,
    connect: false
  })
  const doc = new Y.Doc()
  const binding = provider.attach('no-awareness', doc, { connect: false })

  if (binding.awareness !== null) {
    throw new Error('Expected no awareness instance unless awareness is explicitly enabled')
  }

  provider.destroy()
})

test('creates awareness when awareness: true is set on attach', () => {
  const provider = new MultiplexProvider('ws://127.0.0.1:1234', 'ticket', {
    WebSocketPolyfill: WebSocket,
    connect: false
  })
  const doc = new Y.Doc()
  const binding = provider.attach('with-awareness', doc, { connect: false, awareness: true })

  if (!(binding.awareness instanceof awarenessProtocol.Awareness)) {
    throw new Error('Expected an awareness instance when awareness: true is set')
  }

  provider.destroy()
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
  await waitFor(() => getConnectionsForDoc('ticket', 'auto-cleanup-doc').length === 1, 'Doc was never registered in the server registry')

  await destroyProvider(provider)
  await waitFor(() => getConnectionsForDoc('ticket', 'auto-cleanup-doc').length === 0, 'Doc was not removed after the last connection closed')
  if (cleanDoc('ticket', 'auto-cleanup-doc')) {
    throw new Error('cleanDoc should return false after automatic cleanup removed the doc')
  }
  await testServer.close()
})

test('keeps routed doc awareness alive when one of multiple shared bindings disconnects', async () => {
  const testServer = await createTestServer()

  const providerA = new MultiplexProvider(testServer.url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { client: 'shared' }
  })
  const providerB = new MultiplexProvider(testServer.url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { client: 'shared' }
  })
  const observerProvider = new MultiplexProvider(testServer.url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { client: 'observer' }
  })

  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const observerDoc = new Y.Doc()

  const bindingA = providerA.attach('presence-doc', docA, { disableBc: true, awareness: true })
  const bindingB = providerB.attach('presence-doc', docB, { disableBc: true, awareness: true })
  const observerBinding = observerProvider.attach('presence-doc', observerDoc, { disableBc: true, awareness: true })

  await waitFor(
    () => bindingA.synced && bindingB.synced && observerBinding.synced,
    'Shared presence bindings never synced'
  )

  bindingA.awareness.setLocalStateField('user', 'alice')
  bindingB.awareness.setLocalStateField('user', 'bob')

  await waitFor(
    () => observerBinding.awareness.getStates().has(docA.clientID) && observerBinding.awareness.getStates().has(docB.clientID),
    'Observer never received both shared client awareness states'
  )

  bindingA.destroy()

  await expectForDuration(
    () => observerBinding.awareness.getStates().has(docB.clientID),
    'Disconnecting one shared binding unexpectedly removed the remaining client awareness state',
    6000
  )

  await destroyProvider(providerA)
  await destroyProvider(providerB)
  await destroyProvider(observerProvider)
  await testServer.close()
})

test('clears local awareness view on disconnect while keeping connected peer presence', async () => {
  const testServer = await createTestServer()

  const providerA = new MultiplexProvider(testServer.url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { client: 'a' }
  })
  const providerB = new MultiplexProvider(testServer.url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { client: 'b' }
  })

  const docA = new Y.Doc()
  const docB = new Y.Doc()

  const bindingA = providerA.attach('presence-doc', docA, { disableBc: true, awareness: true })
  const bindingB = providerB.attach('presence-doc', docB, { disableBc: true, awareness: true })

  await waitFor(() => bindingA.synced && bindingB.synced, 'Presence bindings never synced')

  bindingA.awareness.setLocalStateField('user', 'alice')
  bindingB.awareness.setLocalStateField('user', 'bob')

  await waitFor(() => bindingA.awareness.getStates().has(docB.clientID), 'Client A never received client B awareness')
  await waitFor(() => bindingB.awareness.getStates().has(docA.clientID), 'Client B never received client A awareness')

  bindingA.destroy()

  if (bindingA.awareness.getStates().size !== 0) {
    throw new Error('Client A awareness should be empty immediately after disconnect')
  }

  await waitFor(
    () => bindingB.awareness.getStates().size === 1 && bindingB.awareness.getStates().has(docB.clientID),
    'Client B awareness should keep only itself after client A disconnects'
  )

  await destroyProvider(providerA)
  await destroyProvider(providerB)
  await testServer.close()
})

test('restores peer awareness after disconnect and reconnect', async () => {
  const testServer = await createTestServer()

  const providerA = new MultiplexProvider(testServer.url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { client: 'a' }
  })
  const providerB = new MultiplexProvider(testServer.url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { client: 'b' }
  })

  const docA = new Y.Doc()
  const docB = new Y.Doc()

  const bindingA = providerA.attach('presence-doc', docA, { disableBc: true, awareness: true })
  const bindingB = providerB.attach('presence-doc', docB, { disableBc: true, awareness: true })

  await waitFor(() => bindingA.synced && bindingB.synced, 'Presence bindings never synced')

  bindingA.awareness.setLocalStateField('user', 'alice')
  bindingB.awareness.setLocalStateField('user', 'bob')

  await waitFor(
    () => bindingA.awareness.getStates().has(docB.clientID) && bindingB.awareness.getStates().has(docA.clientID),
    'Initial awareness exchange did not complete'
  )

  bindingA.disconnect()
  await waitFor(
    () => bindingB.awareness.getStates().size === 1 && bindingB.awareness.getStates().has(docB.clientID),
    'Client B did not remove client A after disconnect'
  )

  bindingA.connect()
  await waitFor(
    () => bindingA.awareness.getStates().has(docA.clientID) && bindingA.awareness.getStates().has(docB.clientID),
    'Client A did not restore both awareness states after reconnect'
  )
  await waitFor(
    () => bindingB.awareness.getStates().has(docA.clientID) && bindingB.awareness.getStates().has(docB.clientID),
    'Client B did not receive client A awareness after reconnect'
  )

  await destroyProvider(providerA)
  await destroyProvider(providerB)
  await testServer.close()
})

test('restores peer awareness after recreating binding with a new Awareness instance', async () => {
  const testServer = await createTestServer()

  const providerA = new MultiplexProvider(testServer.url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { client: 'a' }
  })
  const providerB = new MultiplexProvider(testServer.url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { client: 'b' }
  })

  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const awarenessB1 = new awarenessProtocol.Awareness(docB)

  const bindingA = providerA.attach('presence-doc', docA, { disableBc: true, awareness: true })
  const bindingB1 = providerB.attach('presence-doc', docB, { disableBc: true, awareness: awarenessB1 })

  await waitFor(() => bindingA.synced && bindingB1.synced, 'Presence bindings never synced')

  bindingA.awareness.setLocalStateField('user', 'alice')
  bindingB1.awareness.setLocalStateField('user', 'bob')

  await waitFor(
    () => bindingA.awareness.getStates().has(docB.clientID) && bindingB1.awareness.getStates().has(docA.clientID),
    'Initial awareness exchange did not complete',
    presenceTimeoutMs
  )

  // Simulate host-side provider lifecycle: recreate routed binding with a new Awareness.
  bindingB1.destroy()

  const awarenessB2 = new awarenessProtocol.Awareness(docB)
  const bindingB2 = providerB.attach('presence-doc', docB, { disableBc: true, awareness: awarenessB2 })
  awarenessB2.setLocalStateField('user', 'bob-recreated')

  await waitFor(
    () => bindingA.awareness.getStates().has(docB.clientID) && bindingB2.awareness.getStates().has(docA.clientID),
    'Client A did not receive client B awareness after binding recreation',
    presenceTimeoutMs
  )

  await destroyProvider(providerA)
  await destroyProvider(providerB)
  await testServer.close()
})

const awarenessScenarioCases = [
  {
    name: 'A up -> B up keeps both peers visible',
    steps: [],
    expectedA: ['A', 'B'],
    expectedB: ['A', 'B'],
    expectationMessage: 'Expected both clients to see A and B after both are online'
  },
  {
    name: 'A up -> B up -> A down results in A[] and B[B]',
    steps: ['A_DOWN'],
    expectedA: [],
    expectedB: ['B'],
    expectationMessage: 'Expected A to be empty and B to keep only itself after A down'
  },
  {
    name: 'A up -> B up -> B down results in A[A] and B[]',
    steps: ['B_DOWN'],
    expectedA: ['A'],
    expectedB: [],
    expectationMessage: 'Expected A to keep only itself and B to be empty after B down'
  },
  {
    name: 'A up -> B up -> A down -> B down results in A[] and B[]',
    steps: ['A_DOWN', 'B_DOWN'],
    expectedA: [],
    expectedB: [],
    expectationMessage: 'Expected both clients to be empty after both go down'
  },
  {
    name: 'A up -> B up -> A down -> A up restores A[A,B] and B[A,B]',
    steps: ['A_DOWN', 'A_UP'],
    expectedA: ['A', 'B'],
    expectedB: ['A', 'B'],
    expectationMessage: 'Expected both clients to see A and B after A reconnects'
  },
  {
    name: 'A up -> B up -> B down -> B up restores A[A,B] and B[A,B]',
    steps: ['B_DOWN', 'B_UP'],
    expectedA: ['A', 'B'],
    expectedB: ['A', 'B'],
    expectationMessage: 'Expected both clients to see A and B after B reconnects'
  },
  {
    name: 'A up -> B up -> A down -> B down -> A up results in A[A] and B[]',
    steps: ['A_DOWN', 'B_DOWN', 'A_UP'],
    expectedA: ['A'],
    expectedB: [],
    expectationMessage: 'Expected A to see only itself and B to remain empty when only A reconnects'
  },
  {
    name: 'A up -> B up -> A down -> B down -> B up results in A[] and B[B]',
    steps: ['A_DOWN', 'B_DOWN', 'B_UP'],
    expectedA: [],
    expectedB: ['B'],
    expectationMessage: 'Expected A to remain empty and B to see only itself when only B reconnects'
  }
]

awarenessScenarioCases.forEach(({ name, ...scenario }) => {
  test(`awareness scenario: ${name}`, async () => {
    await runPresenceScenario(scenario)
  })
})
