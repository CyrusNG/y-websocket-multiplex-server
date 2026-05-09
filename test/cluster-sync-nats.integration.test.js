import test from 'node:test'
import * as Y from 'yjs'
import { Awareness } from '@y/protocols/awareness'
import * as awarenessProtocol from '@y/protocols/awareness'
import * as encoding from 'lib0/encoding'
import { YjsNatsCluster } from '../src/yjs-nats-cluster.js'
import { NatsBus } from '../src/nats-bus.js'

/**
 * @param {() => boolean} predicate
 * @param {string} message
 * @param {number} timeoutMs
 */
const waitFor = async (predicate, message, timeoutMs = 5000) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(message)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const requireNatsConfig = () => {
  if (!process.env.NATS_SERVERS) {
    throw new Error('NATS_SERVERS is required for integration tests')
  }
}

/**
 * @param {'A'|'B'} label
 * @param {number | undefined} clientID
 */
const createNode = async (label, clientID) => {
  const nodeId = label === 'A' ? 'node-a' : 'node-b'
  const doc = new Y.Doc()
  if (typeof clientID === 'number') {
    doc.clientID = clientID
  }
  const awareness = new Awareness(doc)

  const bus = new NatsBus({
    nodeId,
    connectOptions: {
      servers: (process.env.NATS_SERVERS || '').split(',').filter(Boolean),
      user: process.env.NATS_USER || undefined,
      pass: process.env.NATS_PASS || undefined
    },
    subjectTemplate: {
      broadcast: process.env.NATS_BROADCAST_SUBJECT || 'myapp.ydoc.broadcast.{topic}.{channel}.{event}',
      unicast: process.env.NATS_UNICAST_SUBJECT || 'myapp.ydoc.unicast.{nodeId}.{method}'
    }
  })

  const cluster = new YjsNatsCluster({
    bus,
    nodeId,
    resyncInterval: 0
  })

  await cluster.connect()
  await cluster.bindDoc('default', 'presence-doc', doc, awareness)
  awareness.setLocalStateField('user', label === 'A' ? 'alice' : 'bob')
  return { nodeId, doc, awareness, cluster }
}

/**
 * @param {Map<'A'|'B', { nodeId: string, doc: Y.Doc, awareness: Awareness, cluster: YjsNatsCluster }>} activeNodes
 */
const refreshTopology = activeNodes => {
  const aliveNodeIds = Array.from(activeNodes.values()).map(node => node.nodeId).sort()
  activeNodes.forEach(node => {
    const syncNode = aliveNodeIds.find(id => id !== node.nodeId) || null
    node.cluster.setNodes(syncNode, aliveNodeIds)
  })
}

/**
 * @param {'A'|'B'} viewer
 * @param {Map<'A'|'B', number | null>} knownClientIds
 * @param {Map<'A'|'B', { nodeId: string, doc: Y.Doc, awareness: Awareness, cluster: YjsNatsCluster }>} activeNodes
 */
const getAwarenessLabels = (viewer, knownClientIds, activeNodes) => {
  const activeViewer = activeNodes.get(viewer)
  if (activeViewer === undefined) {
    return []
  }
  const states = activeViewer.awareness.getStates()
  return /** @type {Array<'A'|'B'>} */ (['A', 'B'].filter(label => {
    const clientId = knownClientIds.get(label)
    return typeof clientId === 'number' && states.has(clientId)
  }))
}

const same = (actual, expected) => actual.length === expected.length && expected.every(x => actual.includes(x))

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

test('matches 7 awareness up/down scenarios with real NATS', async () => {
  requireNatsConfig()

  /** @type {Array<{ name: string, steps: Array<'A_UP'|'B_UP'|'A_DOWN'|'B_DOWN'>, expectedA: Array<'A'|'B'>, expectedB: Array<'A'|'B'> }>} */
  const scenarios = [
    { name: 'A上 -> B上', steps: ['A_UP', 'B_UP'], expectedA: ['A', 'B'], expectedB: ['A', 'B'] },
    { name: 'A上 -> B上 -> A下', steps: ['A_UP', 'B_UP', 'A_DOWN'], expectedA: [], expectedB: ['B'] },
    { name: 'A上 -> B上 -> B下', steps: ['A_UP', 'B_UP', 'B_DOWN'], expectedA: ['A'], expectedB: [] },
    { name: 'A上 -> B上 -> A下 -> B下', steps: ['A_UP', 'B_UP', 'A_DOWN', 'B_DOWN'], expectedA: [], expectedB: [] },
    { name: 'A上 -> B上 -> A下 -> A上', steps: ['A_UP', 'B_UP', 'A_DOWN', 'A_UP'], expectedA: ['A', 'B'], expectedB: ['A', 'B'] },
    { name: 'A上 -> B上 -> B下 -> B上', steps: ['A_UP', 'B_UP', 'B_DOWN', 'B_UP'], expectedA: ['A', 'B'], expectedB: ['A', 'B'] },
    { name: 'A上 -> B上 -> A下 -> B下 -> A上', steps: ['A_UP', 'B_UP', 'A_DOWN', 'B_DOWN', 'A_UP'], expectedA: ['A'], expectedB: [] }
  ]

  for (const scenario of scenarios) {
    /** @type {Map<'A'|'B', number | null>} */
    const knownClientIds = new Map([['A', null], ['B', null]])
    /** @type {Map<'A'|'B', { nodeId: string, doc: Y.Doc, awareness: Awareness, cluster: YjsNatsCluster }>} */
    const activeNodes = new Map()
    try {
      for (const step of scenario.steps) {
        const label = step.startsWith('A_') ? 'A' : 'B'
        if (step.endsWith('_UP')) {
          if (!activeNodes.has(label)) {
            const node = await createNode(label, knownClientIds.get(label) ?? undefined)
            knownClientIds.set(label, node.doc.clientID)
            activeNodes.set(label, node)
          }
        } else {
          const node = activeNodes.get(label)
          if (node !== undefined) {
            await node.cluster.close()
            activeNodes.delete(label)
          }
        }
        refreshTopology(activeNodes)
        await new Promise(resolve => setTimeout(resolve, 80))
      }

      await waitFor(() => {
        const actualA = getAwarenessLabels('A', knownClientIds, activeNodes)
        const actualB = getAwarenessLabels('B', knownClientIds, activeNodes)
        return same(actualA, scenario.expectedA) && same(actualB, scenario.expectedB)
      }, `Scenario mismatch: ${scenario.name}`)
    } finally {
      await Promise.all(Array.from(activeNodes.values()).map(node => node.cluster.close()))
      activeNodes.clear()
    }
  }
})

test('broadcasts existing locally-controlled awareness to newly joined nodes with real NATS', async () => {
  requireNatsConfig()

  const existingClientId = 9001
  const connToken = {}
  const nodeA = await createNode('A')
  const nodeB = await createNode('B')
  try {
    nodeA.doc.conns = new Map([[connToken, new Set([existingClientId])]])
    awarenessProtocol.applyAwarenessUpdate(
      nodeA.awareness,
      encodeSingleAwarenessUpdate(existingClientId, 1, { user: 'client-1' }),
      connToken
    )

    refreshTopology(new Map([['A', nodeA], ['B', nodeB]]))

    await waitFor(
      () => nodeB.awareness.getStates().has(existingClientId),
      'Node B did not receive existing locally-controlled awareness from node A'
    )
  } finally {
    await nodeA.cluster.close()
    await nodeB.cluster.close()
  }
})

test('restores A on B after B awareness rebind (down -> unbind -> bind -> up)', async () => {
  requireNatsConfig()

  const nodeA = await createNode('A')
  const nodeB = await createNode('B')
  const knownClientIds = new Map([['A', nodeA.doc.clientID], ['B', nodeB.doc.clientID]])
  const activeNodes = new Map([['A', nodeA], ['B', nodeB]])

  try {
    refreshTopology(activeNodes)
    await waitFor(() => {
      const actualA = getAwarenessLabels('A', knownClientIds, activeNodes)
      const actualB = getAwarenessLabels('B', knownClientIds, activeNodes)
      return same(actualA, ['A', 'B']) && same(actualB, ['A', 'B'])
    }, 'Initial awareness did not converge to [A,B] on both nodes')

    nodeB.awareness.setLocalState(null)
    await waitFor(() => {
      const actualA = getAwarenessLabels('A', knownClientIds, activeNodes)
      const actualB = getAwarenessLabels('B', knownClientIds, activeNodes)
      return same(actualA, ['A']) && same(actualB, ['A'])
    }, 'After B down both nodes should converge to [A]')

    await nodeB.cluster.unbindDoc('default', 'presence-doc')
    const bDoc2 = new Y.Doc()
    bDoc2.clientID = knownClientIds.get('B')
    const bAw2 = new Awareness(bDoc2)
    await nodeB.cluster.bindDoc('default', 'presence-doc', bDoc2, bAw2)
    nodeB.doc = bDoc2
    nodeB.awareness = bAw2
    nodeB.awareness.setLocalState({ user: 'bob' })

    await waitFor(() => {
      const actualA = getAwarenessLabels('A', knownClientIds, activeNodes)
      const actualB = getAwarenessLabels('B', knownClientIds, activeNodes)
      return same(actualA, ['A', 'B']) && same(actualB, ['A', 'B'])
    }, 'After B rebind/up both nodes should converge to [A,B]')
  } finally {
    await nodeA.cluster.close()
    await nodeB.cluster.close()
  }
})
