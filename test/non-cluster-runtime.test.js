import test from 'node:test'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { MultiplexProvider } from '../src/multiplex-provider.js'
import { createClusterSyncFromEnv, startWebsocketServer } from '../src/server.js'
import { getYdocCluster } from '../src/cluster.js'
import { setClusterSync } from '../src/utils-docs.js'

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

const getListeningPort = runtime => {
  const address = runtime.server.address()
  if (address == null || typeof address === 'string') {
    throw new Error('Failed to acquire runtime server address')
  }
  return address.port
}

test('runs sync normally without setting up cluster mode', async () => {
  setClusterSync(null)
  if (getYdocCluster() !== null) {
    throw new Error('Expected no active ydoc cluster instance before non-cluster test')
  }

  const runtime = await startWebsocketServer({
    host: '127.0.0.1',
    port: 0
  })
  const port = getListeningPort(runtime)
  const url = `ws://127.0.0.1:${port}`

  const providerA = new MultiplexProvider(url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { connection: 'a' }
  })
  const providerB = new MultiplexProvider(url, 'ticket', {
    WebSocketPolyfill: WebSocket,
    params: { connection: 'b' }
  })

  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const bindingA = providerA.attach('non-cluster-doc', docA, { disableBc: true })
  const bindingB = providerB.attach('non-cluster-doc', docB, { disableBc: true })

  await waitFor(() => bindingA.synced && bindingB.synced, 'Bindings never synced in non-cluster mode')
  docA.getMap('data').set('value', 'non-cluster-ok')
  await waitFor(() => docB.getMap('data').get('value') === 'non-cluster-ok', 'Doc update failed in non-cluster mode')

  await destroyProvider(providerA)
  await destroyProvider(providerB)
  await runtime.close()
})

test('does not create cluster sync from env when nats servers are missing', async () => {
  setClusterSync(null)
  const clusterSync = createClusterSyncFromEnv({
    host: '127.0.0.1',
    port: 1234,
    env: {
      NATS_SERVERS: '',
      NATS_NODE_ID: 'node-a'
    }
  })

  if (clusterSync !== null) {
    throw new Error('Expected createClusterSyncFromEnv to return null without NATS_SERVERS')
  }
  if (getYdocCluster() !== null) {
    throw new Error('No ydoc cluster instance should be created in non-cluster env config')
  }
})
