import test from 'node:test'
import * as Y from 'yjs'
import { Awareness } from '@y/protocols/awareness'
import * as awarenessProtocol from '@y/protocols/awareness'
import * as encoding from 'lib0/encoding'
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

/**
 * @param {number} clientID
 * @param {number} clock
 * @param {any} state
 * @returns {Uint8Array}
 */
const encodeSingleAwarenessUpdate = (clientID, clock, state) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint(encoder, clientID)
  encoding.writeVarUint(encoder, clock)
  encoding.writeVarString(encoder, JSON.stringify(state))
  return encoding.toUint8Array(encoder)
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
    resyncInterval: 0
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

const runNodeLifecycleScenario = async ({ scenarioName, steps, finalExpectedA, finalExpectedB }) => {
  const broker = new InMemoryBroker()
  /** @type {{ nodeA: ReturnType<typeof createClusterNode> | null, nodeB: ReturnType<typeof createClusterNode> | null }} */
  const state = { nodeA: null, nodeB: null }

  const ensureTopology = () => {
    if (state.nodeA && state.nodeB) {
      state.nodeA.cluster.setNodes('node-b', ['node-a', 'node-b'])
      state.nodeB.cluster.setNodes('node-a', ['node-a', 'node-b'])
    } else if (state.nodeA) {
      state.nodeA.cluster.setNodes(null, ['node-a'])
    } else if (state.nodeB) {
      state.nodeB.cluster.setNodes(null, ['node-b'])
    }
  }

  const stepUpNodeA = async () => {
    if (state.nodeA) return
    state.nodeA = createClusterNode({ nodeId: 'node-a', broker })
    await state.nodeA.cluster.connect()
    await state.nodeA.cluster.bindDoc('default', 'presence-doc', state.nodeA.doc, state.nodeA.awareness)
    state.nodeA.awareness.setLocalStateField('user', 'alice')
    ensureTopology()
  }
  const stepUpNodeB = async () => {
    if (state.nodeB) return
    state.nodeB = createClusterNode({ nodeId: 'node-b', broker })
    await state.nodeB.cluster.connect()
    await state.nodeB.cluster.bindDoc('default', 'presence-doc', state.nodeB.doc, state.nodeB.awareness)
    state.nodeB.awareness.setLocalStateField('user', 'bob')
    ensureTopology()
  }
  const stepDownNodeA = async () => {
    if (!state.nodeA) return
    await state.nodeA.cluster.close()
    state.nodeA = null
    if (state.nodeB) {
      state.nodeB.cluster.removeNode('node-a')
    }
    ensureTopology()
  }
  const stepDownNodeB = async () => {
    if (!state.nodeB) return
    await state.nodeB.cluster.close()
    state.nodeB = null
    if (state.nodeA) {
      state.nodeA.cluster.removeNode('node-b')
    }
    ensureTopology()
  }

  try {
    for (const step of steps) {
      if (step === 'NODE_1_UP') await stepUpNodeA()
      if (step === 'NODE_2_UP') await stepUpNodeB()
      if (step === 'NODE_1_DOWN') await stepDownNodeA()
      if (step === 'NODE_2_DOWN') await stepDownNodeB()
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    if (state.nodeA) {
      await waitFor(
        () => {
          const hasSelf = state.nodeA && state.nodeA.awareness.getStates().has(state.nodeA.doc.clientID)
          const hasPeer = state.nodeA && state.nodeB && state.nodeA.awareness.getStates().has(state.nodeB.doc.clientID)
          return finalExpectedA === 'A_ONLY' ? hasSelf && !hasPeer : hasSelf && hasPeer
        },
        `Scenario "${scenarioName}": node-1 final awareness mismatch`
      )
    }
    if (state.nodeB) {
      await waitFor(
        () => {
          const hasSelf = state.nodeB && state.nodeB.awareness.getStates().has(state.nodeB.doc.clientID)
          const hasPeer = state.nodeB && state.nodeA && state.nodeB.awareness.getStates().has(state.nodeA.doc.clientID)
          return finalExpectedB === 'B_ONLY' ? hasSelf && !hasPeer : hasSelf && hasPeer
        },
        `Scenario "${scenarioName}": node-2 final awareness mismatch`
      )
    }
  } finally {
    if (state.nodeA) await state.nodeA.cluster.close()
    if (state.nodeB) await state.nodeB.cluster.close()
  }
}

const nodeLifecycleScenarios = [
  {
    name: 'node-1 up -> node-2 up',
    steps: ['NODE_1_UP', 'NODE_2_UP'],
    finalExpectedA: 'A_AND_B',
    finalExpectedB: 'A_AND_B'
  },
  {
    name: 'node-1 up -> node-2 up -> node-2 down -> node-2 up',
    steps: ['NODE_1_UP', 'NODE_2_UP', 'NODE_2_DOWN', 'NODE_2_UP'],
    finalExpectedA: 'A_AND_B',
    finalExpectedB: 'A_AND_B'
  },
  {
    name: 'node-1 up -> node-2 up -> node-1 down -> node-2 down -> node-2 up -> node-1 up',
    steps: ['NODE_1_UP', 'NODE_2_UP', 'NODE_1_DOWN', 'NODE_2_DOWN', 'NODE_2_UP', 'NODE_1_UP'],
    finalExpectedA: 'A_AND_B',
    finalExpectedB: 'A_AND_B'
  }
]

nodeLifecycleScenarios.forEach(scenario => {
  test(`node lifecycle scenario: ${scenario.name}`, async () => {
    await runNodeLifecycleScenario(scenario)
  })
})

const same = (actual, expected) => actual.length === expected.length && expected.every(x => actual.includes(x))

const runClientAwarenessScenario = async ({ scenarioName, steps, expectedA, expectedB }) => {
  const broker = new InMemoryBroker()
  /** @type {{ A: ReturnType<typeof createClusterNode> | null, B: ReturnType<typeof createClusterNode> | null }} */
  const activeNodes = { A: null, B: null }
  /** @type {Map<'A'|'B', number | null>} */
  const knownClientIds = new Map([['A', null], ['B', null]])

  const refreshTopology = () => {
    const nodeA = activeNodes.A
    const nodeB = activeNodes.B
    if (nodeA && nodeB) {
      nodeA.cluster.setNodes('node-b', ['node-a', 'node-b'])
      nodeB.cluster.setNodes('node-a', ['node-a', 'node-b'])
    } else if (nodeA) {
      nodeA.cluster.setNodes(null, ['node-a'])
    } else if (nodeB) {
      nodeB.cluster.setNodes(null, ['node-b'])
    }
  }

  const getLabels = viewer => {
    const current = activeNodes[viewer]
    if (!current) {
      return []
    }
    const states = current.awareness.getStates()
    return /** @type {Array<'A'|'B'>} */ (['A', 'B'].filter(label => {
      const id = knownClientIds.get(label)
      return typeof id === 'number' && states.has(id)
    }))
  }

  const up = async label => {
    if (activeNodes[label]) return
    const node = createClusterNode({
      nodeId: label === 'A' ? 'node-a' : 'node-b',
      broker,
      clientID: knownClientIds.get(label) ?? undefined
    })
    await node.cluster.connect()
    await node.cluster.bindDoc('default', 'presence-doc', node.doc, node.awareness)
    node.awareness.setLocalStateField('user', label === 'A' ? 'alice' : 'bob')
    knownClientIds.set(label, node.doc.clientID)
    activeNodes[label] = node
    refreshTopology()
  }

  const down = async label => {
    const node = activeNodes[label]
    if (!node) return
    await node.cluster.close()
    activeNodes[label] = null
    const peerLabel = label === 'A' ? 'B' : 'A'
    if (activeNodes[peerLabel]) {
      activeNodes[peerLabel].cluster.removeNode(label === 'A' ? 'node-a' : 'node-b')
    }
    refreshTopology()
  }

  try {
    await up('A')
    await up('B')

    await waitFor(
      () => same(getLabels('A'), ['A', 'B']) && same(getLabels('B'), ['A', 'B']),
      `Scenario "${scenarioName}": initial awareness did not converge`
    )

    for (const step of steps) {
      if (step === 'A_DOWN') await down('A')
      if (step === 'A_UP') await up('A')
      if (step === 'B_DOWN') await down('B')
      if (step === 'B_UP') await up('B')
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    await waitFor(
      () => same(getLabels('A'), expectedA) && same(getLabels('B'), expectedB),
      `Scenario "${scenarioName}": final awareness mismatch`
    )
  } finally {
    if (activeNodes.A) await activeNodes.A.cluster.close()
    if (activeNodes.B) await activeNodes.B.cluster.close()
  }
}

const clientAwarenessScenarioCases = [
  { name: 'client-A@node-a up -> client-B@node-b up', steps: [], expectedA: ['A', 'B'], expectedB: ['A', 'B'] },
  { name: 'client-A@node-a up -> client-B@node-b up -> client-A@node-a down', steps: ['A_DOWN'], expectedA: [], expectedB: ['B'] },
  { name: 'client-A@node-a up -> client-B@node-b up -> client-B@node-b down', steps: ['B_DOWN'], expectedA: ['A'], expectedB: [] },
  { name: 'client-A@node-a up -> client-B@node-b up -> client-A@node-a down -> client-B@node-b down', steps: ['A_DOWN', 'B_DOWN'], expectedA: [], expectedB: [] },
  { name: 'client-A@node-a up -> client-B@node-b up -> client-A@node-a down -> client-A@node-a up', steps: ['A_DOWN', 'A_UP'], expectedA: ['A', 'B'], expectedB: ['A', 'B'] },
  { name: 'client-A@node-a up -> client-B@node-b up -> client-B@node-b down -> client-B@node-b up', steps: ['B_DOWN', 'B_UP'], expectedA: ['A', 'B'], expectedB: ['A', 'B'] },
  { name: 'client-A@node-a up -> client-B@node-b up -> client-A@node-a down -> client-B@node-b down -> client-A@node-a up', steps: ['A_DOWN', 'B_DOWN', 'A_UP'], expectedA: ['A'], expectedB: [] },
  { name: 'client-A@node-a up -> client-B@node-b up -> client-A@node-a down -> client-B@node-b down -> client-B@node-b up', steps: ['A_DOWN', 'B_DOWN', 'B_UP'], expectedA: [], expectedB: ['B'] }
]

clientAwarenessScenarioCases.forEach(({ name, ...scenario }) => {
  test(`client awareness scenario: ${name}`, async () => {
    await runClientAwarenessScenario({ scenarioName: name, ...scenario })
  })
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

test('broadcasts existing locally-controlled awareness to newly joined nodes', async () => {
  const broker = new InMemoryBroker()
  const nodeA = createClusterNode({ nodeId: 'node-a', broker })
  const nodeB = createClusterNode({ nodeId: 'node-b', broker })

  const existingClientId = 9001
  const connToken = {}
  nodeA.doc.conns = new Map([[connToken, new Set([existingClientId])]])
  awarenessProtocol.applyAwarenessUpdate(
    nodeA.awareness,
    encodeSingleAwarenessUpdate(existingClientId, 1, { user: 'client-1' }),
    connToken
  )

  await nodeA.cluster.connect()
  await nodeB.cluster.connect()
  await nodeA.cluster.bindDoc('default', 'presence-doc', nodeA.doc, nodeA.awareness)
  await nodeB.cluster.bindDoc('default', 'presence-doc', nodeB.doc, nodeB.awareness)

  nodeA.cluster.setNodes('node-b', ['node-a', 'node-b'])
  nodeB.cluster.setNodes('node-a', ['node-a', 'node-b'])

  await waitFor(
    () => nodeB.awareness.getStates().has(existingClientId),
    'Node B did not receive existing locally-controlled awareness from node A'
  )

  await nodeA.cluster.close()
  await nodeB.cluster.close()
})

test('backfills existing awareness when remote doc binds after topology join', async () => {
  const broker = new InMemoryBroker()
  const nodeA = createClusterNode({ nodeId: 'node-a', broker })
  const nodeB = createClusterNode({ nodeId: 'node-b', broker })

  await nodeA.cluster.connect()
  await nodeB.cluster.connect()
  await nodeA.cluster.bindDoc('default', 'presence-doc', nodeA.doc, nodeA.awareness)

  nodeA.cluster.setNodes('node-b', ['node-a', 'node-b'])
  nodeB.cluster.setNodes('node-a', ['node-a', 'node-b'])

  nodeA.awareness.setLocalStateField('user', 'alice')
  await nodeB.cluster.bindDoc('default', 'presence-doc', nodeB.doc, nodeB.awareness)
  nodeB.awareness.setLocalStateField('user', 'bob')

  await waitFor(
    () => nodeB.awareness.getStates().has(nodeA.doc.clientID),
    'Node B did not receive node A awareness after late doc bind'
  )

  await nodeA.cluster.close()
  await nodeB.cluster.close()
})

test('does not replay stale remote awareness after both peers go offline and local rebind', async () => {
  const broker = new InMemoryBroker()
  const nodeA1 = createClusterNode({ nodeId: 'node-a', broker })
  const nodeB = createClusterNode({ nodeId: 'node-b', broker })

  await nodeA1.cluster.connect()
  await nodeB.cluster.connect()
  await nodeA1.cluster.bindDoc('default', 'presence-doc', nodeA1.doc, nodeA1.awareness)
  await nodeB.cluster.bindDoc('default', 'presence-doc', nodeB.doc, nodeB.awareness)
  nodeA1.cluster.setNodes('node-b', ['node-a', 'node-b'])
  nodeB.cluster.setNodes('node-a', ['node-a', 'node-b'])

  nodeA1.awareness.setLocalStateField('user', 'alice')
  nodeB.awareness.setLocalStateField('user', 'bob')
  await waitFor(
    () => nodeA1.awareness.getStates().has(nodeB.doc.clientID),
    'Node A1 never received initial node B awareness'
  )

  await nodeA1.cluster.close()
  await nodeB.cluster.close()

  const nodeA2 = createClusterNode({ nodeId: 'node-a', broker })
  await nodeA2.cluster.connect()
  await nodeA2.cluster.bindDoc('default', 'presence-doc', nodeA2.doc, nodeA2.awareness)
  nodeA2.cluster.setNodes(null, ['node-a'])
  nodeA2.awareness.setLocalStateField('user', 'alice-rejoin')

  await waitFor(
    () => nodeA2.awareness.getStates().has(nodeA2.doc.clientID),
    'Node A2 local awareness not present after rejoin'
  )

  if (nodeA2.awareness.getStates().has(nodeB.doc.clientID)) {
    throw new Error('Node A2 should not replay stale node B awareness after both peers were offline')
  }

  await nodeA2.cluster.close()
})
