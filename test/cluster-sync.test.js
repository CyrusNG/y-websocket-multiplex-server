import test from 'node:test'
import * as Y from 'yjs'
import { Awareness } from '@y/protocols/awareness'
import { YjsNatsCluster } from '../src/yjs-nats-cluster.js'

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

class InMemoryBroker {
  constructor () {
    /** @type {Map<string, Set<(payload: Uint8Array) => void | Promise<void>>>} */
    this.topicHandlers = new Map()
    /** @type {Map<string, (payload: Uint8Array) => Uint8Array | Promise<Uint8Array>>} */
    this.rpcHandlers = new Map()
  }

  /**
   * @param {string} topic
   * @param {(payload: Uint8Array) => void | Promise<void>} handler
   * @returns {() => void}
   */
  addTopicHandler (topic, handler) {
    const handlers = this.topicHandlers.get(topic) || new Set()
    handlers.add(handler)
    this.topicHandlers.set(topic, handlers)
    return () => {
      const current = this.topicHandlers.get(topic)
      if (!current) {
        return
      }
      current.delete(handler)
      if (current.size === 0) {
        this.topicHandlers.delete(topic)
      }
    }
  }

  /**
   * @param {string} topic
   * @param {Uint8Array} payload
   */
  publishTopic (topic, payload) {
    const handlers = this.topicHandlers.get(topic)
    if (!handlers) {
      return
    }
    handlers.forEach(handler => {
      Promise.resolve(handler(payload)).catch(() => {})
    })
  }

  /**
   * @param {string} nodeId
   * @param {string} method
   * @param {(payload: Uint8Array) => Uint8Array | Promise<Uint8Array>} handler
   * @returns {() => void}
   */
  setRpcHandler (nodeId, method, handler) {
    const key = `${nodeId}::${method}`
    this.rpcHandlers.set(key, handler)
    return () => {
      const current = this.rpcHandlers.get(key)
      if (current === handler) {
        this.rpcHandlers.delete(key)
      }
    }
  }

  /**
   * @param {string} nodeId
   * @param {string} method
   * @param {Uint8Array} payload
   * @returns {Promise<Uint8Array>}
   */
  async requestRpc (nodeId, method, payload) {
    const key = `${nodeId}::${method}`
    const handler = this.rpcHandlers.get(key)
    if (!handler) {
      throw new Error(`Missing RPC handler for ${key}`)
    }
    return handler(payload)
  }
}

class InMemoryBus {
  /**
   * @param {{ nodeId: string, broker: InMemoryBroker }} options
   */
  constructor ({ nodeId, broker }) {
    this.nodeId = nodeId
    this.broker = broker
    this.connected = false
    /** @type {Array<() => void>} */
    this.unsubs = []
  }

  async connect () {
    this.connected = true
  }

  async close () {
    this.unsubs.forEach(unsub => { unsub() })
    this.unsubs = []
    this.connected = false
  }

  /**
   * @param {string} topic
   * @param {Uint8Array} payload
   */
  async publish (topic, payload) {
    this.broker.publishTopic(topic, payload)
  }

  /**
   * @param {string} topic
   * @param {(payload: Uint8Array, meta: any) => void | Promise<void>} handler
   * @returns {Promise<() => void>}
   */
  async subscribe (topic, handler) {
    const unsub = this.broker.addTopicHandler(topic, payload => handler(payload, {
      subject: topic,
      reply: '',
      headers: null,
      senderNodeId: null
    }))
    this.unsubs.push(unsub)
    return unsub
  }

  /**
   * @param {string} targetNodeId
   * @param {string} method
   * @param {Uint8Array} payload
   * @returns {Promise<Uint8Array>}
   */
  async request (targetNodeId, method, payload) {
    return this.broker.requestRpc(targetNodeId, method, payload)
  }

  /**
   * @param {string} method
   * @param {(payload: Uint8Array, meta: any) => Uint8Array | Promise<Uint8Array>} handler
   * @returns {Promise<() => void>}
   */
  async handle (method, handler) {
    const unsub = this.broker.setRpcHandler(this.nodeId, method, payload => handler(payload, {
      subject: method,
      reply: '',
      headers: null,
      senderNodeId: null
    }))
    this.unsubs.push(unsub)
    return unsub
  }
}

/**
 * @param {{ nodeId: string, broker: InMemoryBroker, clientID?: number }} options
 */
const createClusterNode = ({ nodeId, broker, clientID }) => {
  const doc = new Y.Doc()
  if (typeof clientID === 'number') {
    doc.clientID = clientID
  }
  const awareness = new Awareness(doc)
  const bus = new InMemoryBus({ nodeId, broker })
  const cluster = new YjsNatsCluster({
    bus,
    nodeId,
    resyncIntervalMs: 0
  })
  return { doc, awareness, cluster }
}

test('syncs doc state across cluster nodes via update and resync', async () => {
  const broker = new InMemoryBroker()
  const nodeA = createClusterNode({ nodeId: 'node-a', broker })
  const nodeB = createClusterNode({ nodeId: 'node-b', broker })

  await nodeA.cluster.connect()
  await nodeB.cluster.connect()

  nodeA.doc.getMap('data').set('value', 'seed-from-a')
  await nodeA.cluster.bindDoc('default', 'cluster-doc', nodeA.doc, nodeA.awareness)
  await nodeB.cluster.bindDoc('default', 'cluster-doc', nodeB.doc, nodeB.awareness)
  nodeA.cluster.setNodes('node-b', ['node-a', 'node-b'])
  nodeB.cluster.setNodes('node-a', ['node-a', 'node-b'])
  await nodeB.cluster.resyncDoc('default', 'cluster-doc')

  await waitFor(
    () => nodeB.doc.getMap('data').get('value') === 'seed-from-a',
    'Node B did not receive initial resync state from node A'
  )

  nodeA.doc.getMap('data').set('value', 'live-update')
  await waitFor(
    () => nodeB.doc.getMap('data').get('value') === 'live-update',
    'Node B did not receive live update from node A'
  )

  await nodeA.cluster.close()
  await nodeB.cluster.close()
})

test('preserves updateId when forwarding client-origin update across cluster nodes', async () => {
  const broker = new InMemoryBroker()
  const nodeA = createClusterNode({ nodeId: 'node-a', broker })
  const nodeB = createClusterNode({ nodeId: 'node-b', broker })
  const forwardedUpdateId = 'client-update-fixed-id'

  /** @type {any} */
  let remoteOriginOnB = null
  nodeB.doc.on('update', (_update, origin) => {
    if (origin && typeof origin === 'object' && origin.source === 'cluster') {
      remoteOriginOnB = origin
    }
  })

  await nodeA.cluster.connect()
  await nodeB.cluster.connect()
  await nodeA.cluster.bindDoc('default', 'cluster-doc', nodeA.doc, nodeA.awareness)
  await nodeB.cluster.bindDoc('default', 'cluster-doc', nodeB.doc, nodeB.awareness)
  nodeA.cluster.setNodes('node-b', ['node-a', 'node-b'])
  nodeB.cluster.setNodes('node-a', ['node-a', 'node-b'])

  nodeA.doc.transact(() => {
    nodeA.doc.getMap('data').set('value', 'from-client-origin')
  }, {
    source: 'client',
    meta: {
      updateId: forwardedUpdateId
    }
  })

  await waitFor(
    () => nodeB.doc.getMap('data').get('value') === 'from-client-origin',
    'Node B did not receive forwarded client-origin update'
  )
  await waitFor(
    () => remoteOriginOnB !== null,
    'Node B did not observe cluster origin metadata for forwarded update'
  )

  if (remoteOriginOnB.meta?.updateId !== forwardedUpdateId) {
    throw new Error(`Expected forwarded updateId "${forwardedUpdateId}", got "${String(remoteOriginOnB.meta?.updateId)}"`)
  }

  await nodeA.cluster.close()
  await nodeB.cluster.close()
})

test('removes remote awareness when a cluster node is removed', async () => {
  const broker = new InMemoryBroker()
  const nodeA = createClusterNode({ nodeId: 'node-a', broker })
  const nodeB = createClusterNode({ nodeId: 'node-b', broker })

  await nodeA.cluster.connect()
  await nodeB.cluster.connect()
  await nodeA.cluster.bindDoc('default', 'presence-doc', nodeA.doc, nodeA.awareness)
  await nodeB.cluster.bindDoc('default', 'presence-doc', nodeB.doc, nodeB.awareness)
  nodeB.cluster.setNodes('node-a', ['node-a', 'node-b'])

  nodeA.awareness.setLocalStateField('user', 'alice')
  await waitFor(
    () => nodeB.awareness.getStates().has(nodeA.doc.clientID),
    'Node B never received awareness state from node A'
  )

  nodeB.cluster.removeNode('node-a')
  await waitFor(
    () => !nodeB.awareness.getStates().has(nodeA.doc.clientID),
    'Node B did not clear awareness state after node-a removal'
  )

  await nodeA.cluster.close()
  await nodeB.cluster.close()
})

test('restores awareness immediately when a removed cluster node rejoins with same client id', async () => {
  const broker = new InMemoryBroker()
  const nodeA1 = createClusterNode({ nodeId: 'node-a', broker })
  const nodeB = createClusterNode({ nodeId: 'node-b', broker })

  await nodeA1.cluster.connect()
  await nodeB.cluster.connect()
  await nodeA1.cluster.bindDoc('default', 'presence-doc', nodeA1.doc, nodeA1.awareness)
  await nodeB.cluster.bindDoc('default', 'presence-doc', nodeB.doc, nodeB.awareness)
  nodeA1.cluster.setNodes('node-b', ['node-a', 'node-b'])
  nodeB.cluster.setNodes('node-a', ['node-a', 'node-b'])

  const reconnectClientId = nodeA1.doc.clientID
  nodeA1.awareness.setLocalStateField('user', 'alice-before-rejoin')
  await waitFor(
    () => nodeB.awareness.getStates().has(reconnectClientId),
    'Node B never received initial awareness state from node A'
  )

  nodeB.cluster.removeNode('node-a')
  await waitFor(
    () => !nodeB.awareness.getStates().has(reconnectClientId),
    'Node B did not clear removed node awareness state'
  )
  if (nodeB.awareness.meta.has(reconnectClientId)) {
    throw new Error('Node B should clear removed node awareness meta clock before rejoin')
  }
  await nodeA1.cluster.close()

  const nodeA2 = createClusterNode({ nodeId: 'node-a', broker, clientID: reconnectClientId })
  await nodeA2.cluster.connect()
  await nodeA2.cluster.bindDoc('default', 'presence-doc', nodeA2.doc, nodeA2.awareness)
  nodeA2.cluster.setNodes('node-b', ['node-a', 'node-b'])
  nodeB.cluster.setNodes('node-a', ['node-a', 'node-b'])

  nodeA2.awareness.setLocalStateField('user', 'alice-after-rejoin')
  if (!nodeA2.awareness.getStates().has(reconnectClientId)) {
    const localKeys = Array.from(nodeA2.awareness.getStates().keys())
    throw new Error(`Node A rejoin awareness did not use expected client id ${reconnectClientId}, local keys: [${localKeys.join(',')}]`)
  }
  try {
    await waitFor(
      () => nodeB.awareness.getStates().has(reconnectClientId),
      'Node B did not restore node A awareness immediately after rejoin',
      1000
    )
  } catch (_err) {
    const stateKeys = Array.from(nodeB.awareness.getStates().keys())
    throw new Error(`Node B did not restore node A awareness immediately after rejoin; expected client ${reconnectClientId}, actual clients: [${stateKeys.join(',')}]`)
  }

  await nodeA2.cluster.close()
  await nodeB.cluster.close()
})

test('rebinds cluster doc when the same doc key is bound with a new doc instance', async () => {
  const broker = new InMemoryBroker()
  const nodeA = createClusterNode({ nodeId: 'node-a', broker })
  const nodeB = createClusterNode({ nodeId: 'node-b', broker })

  await nodeA.cluster.connect()
  await nodeB.cluster.connect()
  await nodeA.cluster.bindDoc('default', 'presence-doc', nodeA.doc, nodeA.awareness)
  await nodeB.cluster.bindDoc('default', 'presence-doc', nodeB.doc, nodeB.awareness)
  nodeA.cluster.setNodes('node-b', ['node-a', 'node-b'])
  nodeB.cluster.setNodes('node-a', ['node-a', 'node-b'])

  nodeA.awareness.setLocalStateField('user', 'alice-initial')
  await waitFor(
    () => nodeB.awareness.getStates().has(nodeA.doc.clientID),
    'Node B never received initial awareness state from node A'
  )

  const reboundDoc = new Y.Doc()
  const reboundAwareness = new Awareness(reboundDoc)
  await nodeA.cluster.bindDoc('default', 'presence-doc', reboundDoc, reboundAwareness)

  reboundAwareness.setLocalStateField('user', 'alice-rebound')
  await waitFor(
    () => nodeB.awareness.getStates().has(reboundDoc.clientID),
    'Node B did not receive awareness from rebound doc instance'
  )

  await nodeA.cluster.close()
  await nodeB.cluster.close()
})

test('keeps peer online and restores awareness within 1s after local rebind', async () => {
  const broker = new InMemoryBroker()
  const nodeA = createClusterNode({ nodeId: 'node-a', broker })
  const nodeB1 = createClusterNode({ nodeId: 'node-b', broker })

  await nodeA.cluster.connect()
  await nodeB1.cluster.connect()
  await nodeA.cluster.bindDoc('default', 'presence-doc', nodeA.doc, nodeA.awareness)
  await nodeB1.cluster.bindDoc('default', 'presence-doc', nodeB1.doc, nodeB1.awareness)
  nodeA.cluster.setNodes('node-b', ['node-a', 'node-b'])
  nodeB1.cluster.setNodes('node-a', ['node-a', 'node-b'])

  nodeA.awareness.setLocalStateField('user', 'alice')
  nodeB1.awareness.setLocalStateField('user', 'bob-before-rebind')
  await waitFor(
    () => nodeA.awareness.getStates().has(nodeB1.doc.clientID),
    'Node A never received initial awareness state from node B'
  )

  const nodeB2Doc = new Y.Doc()
  const nodeB2Awareness = new Awareness(nodeB2Doc)
  await nodeB1.cluster.bindDoc('default', 'presence-doc', nodeB2Doc, nodeB2Awareness)
  nodeB2Awareness.setLocalStateField('user', 'bob-after-rebind')

  await waitFor(
    () => nodeA.awareness.getStates().has(nodeB2Doc.clientID),
    'Node A did not receive rebound node B awareness within 1s',
    1000
  )

  await nodeA.cluster.close()
  await nodeB1.cluster.close()
})
