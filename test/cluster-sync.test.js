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
 * @param {{ nodeId: string, broker: InMemoryBroker }} options
 */
const createClusterNode = ({ nodeId, broker }) => {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const bus = new InMemoryBus({ nodeId, broker })
  const cluster = new YjsNatsCluster({
    bus,
    nodeId,
    defaultNamespace: 'default',
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
