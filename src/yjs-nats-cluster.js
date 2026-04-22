import * as awarenessProtocol from '@y/protocols/awareness'
import { DocSyncEngine } from './doc-sync-engine.js'
import { NatsDocTransport } from './nats-doc-transport.js'

/**
 * @typedef {import('./types.js').YjsNatsClusterOptions} YjsNatsClusterOptions
 * @typedef {import('./types.js').BoundDocState} BoundDocState
 */

const ORIGIN_CLUSTER = Symbol('yjs-nats-cluster-origin')

const getDocKey = (namespace, docName) => `${namespace}:${docName}`

class YjsNatsCluster {
  /**
   * @param {YjsNatsClusterOptions} opts
   */
  constructor ({
    bus,
    nodeId,
    chooseSyncNode,
    resyncIntervalMs = 30000
  }) {
    this.bus = bus
    this.nodeId = nodeId
    this.chooseSyncNode = chooseSyncNode || null
    this.resyncIntervalMs = resyncIntervalMs
    this.syncNode = null
    this.aliveNodes = new Set([this.nodeId])

    this.transport = new NatsDocTransport({ bus: this.bus })

    /** @type {Map<string, BoundDocState>} */
    this.boundDocs = new Map()
    this.resyncIntervalId = null
  }

  /**
   * @returns {Promise<void>}
   */
  async connect () {
    await this.bus.connect()
    if (this.resyncIntervalMs > 0 && this.resyncIntervalId === null) {
      this.resyncIntervalId = setInterval(() => {
        this.boundDocs.forEach((state, docKey) => {
          this.resyncDoc(state.namespace, state.docName).catch(err => {
            console.error('cluster resync failed', docKey, err)
          })
        })
      }, this.resyncIntervalMs)
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async close () {
    if (this.resyncIntervalId !== null) {
      clearInterval(this.resyncIntervalId)
      this.resyncIntervalId = null
    }
    this.boundDocs.forEach(state => {
      state.unsubs.forEach(unsub => { unsub() })
      state.engine.destroy()
    })
    this.boundDocs.clear()
    await this.bus.close()
  }

  /**
   * @param {string} namespace
   * @param {string} docName
   * @param {import('yjs').Doc} doc
   * @param {awarenessProtocol.Awareness} awareness
   * @returns {Promise<{ destroy: () => Promise<void>, docName: string, namespace: string }>}
   */
  async bindDoc (namespace, docName, doc, awareness) {
    const ns = namespace
    const docKey = getDocKey(ns, docName)
    const existing = this.boundDocs.get(docKey)
    if (existing !== undefined) {
      if (existing.doc === doc && existing.awareness === awareness) {
        return {
          namespace: ns,
          docName,
          destroy: async () => {
            await this.unbindDoc(ns, docName)
          }
        }
      }
      existing.unsubs.forEach(unsub => { unsub() })
      existing.engine.destroy()
      this.boundDocs.delete(docKey)
    }

    /** @type {BoundDocState} */
    const state = {
      namespace: ns,
      docName,
      doc,
      awareness,
      ownedAwarenessClientsByNode: new Map(),
      unsubs: [],
      engine: /** @type {any} */ (null)
    }

    state.engine = new DocSyncEngine({
      doc,
      awareness,
      docKey,
      nodeId: this.nodeId,
      transport: this.transport,
      remoteOrigin: ORIGIN_CLUSTER,
      onRemoteAwareness: (senderNodeId, changedClients) => {
        this.updateAwarenessOwnership(state, senderNodeId, changedClients)
      }
    })

    this.boundDocs.set(docKey, state)

    await state.engine.connect()

    const localAwarenessObserver = ({ added, updated, removed }, origin) => {
      if (origin === ORIGIN_CLUSTER) {
        return
      }
      const changedClients = Array.from(new Set(added.concat(updated, removed)))
      if (changedClients.length > 0) {
        this.updateAwarenessOwnership(state, this.nodeId, changedClients)
      }
    }
    awareness.on('update', localAwarenessObserver)
    state.unsubs.push(() => {
      awareness.off('update', localAwarenessObserver)
    })

    await this.resyncDoc(ns, docName)

    return {
      namespace: ns,
      docName,
      destroy: async () => {
        await this.unbindDoc(ns, docName)
      }
    }
  }

  /**
   * @param {string} namespace
   * @param {string} docName
   * @returns {Promise<void>}
   */
  async unbindDoc (namespace, docName) {
    const ns = namespace
    const docKey = getDocKey(ns, docName)
    const state = this.boundDocs.get(docKey)
    if (state === undefined) {
      return
    }

    state.unsubs.forEach(unsub => { unsub() })
    state.engine.destroy()
    this.boundDocs.delete(docKey)
  }

  /**
   * @param {string} namespace
   * @param {string} docName
   * @returns {Promise<boolean>}
   */
  async resyncDoc (namespace, docName) {
    const ns = namespace
    const docKey = getDocKey(ns, docName)
    const state = this.boundDocs.get(docKey)
    if (state === undefined) {
      return false
    }

    const aliveNodes = Array.from(this.aliveNodes)
    const targetNode = this.resolveSyncNode(docKey, aliveNodes)
    if (targetNode === null || targetNode === this.nodeId) {
      return false
    }

    await state.engine.resyncFrom(targetNode)
    return true
  }

  /**
   * @param {string} nodeId
   */
  handleNodeDown (nodeId) {
    this.boundDocs.forEach(state => {
      const removed = state.ownedAwarenessClientsByNode.get(nodeId)
      if (removed === undefined || removed.size === 0) {
        return
      }
      state.ownedAwarenessClientsByNode.delete(nodeId)
      const removedClients = Array.from(removed)
      awarenessProtocol.removeAwarenessStates(state.awareness, removedClients, state.engine.syncCore.remoteOrigin)
      removedClients.forEach(clientID => {
        if (clientID !== state.doc.clientID) {
          state.awareness.meta.delete(clientID)
        }
      })
    })
  }

  /**
   * Pushes the latest node topology snapshot from the host runtime.
   *
   * @param {string | null | undefined} syncNode
   * @param {Array<string>} nodeIds
   */
  setNodes (syncNode, nodeIds) {
    const nextNodes = new Set(nodeIds.filter(nodeId => typeof nodeId === 'string' && nodeId.length > 0))
    nextNodes.add(this.nodeId)
    this.aliveNodes.forEach(nodeId => {
      if (!nextNodes.has(nodeId)) {
        this.handleNodeDown(nodeId)
      }
    })
    this.syncNode = typeof syncNode === 'string' && syncNode.length > 0 ? syncNode : null
    this.aliveNodes = nextNodes
  }

  /**
   * Pushes a specific node removal event from the host runtime.
   *
   * @param {string} nodeId
   */
  removeNode (nodeId) {
    if (nodeId === this.nodeId) {
      return
    }
    const existed = this.aliveNodes.delete(nodeId)
    if (this.syncNode === nodeId) {
      this.syncNode = null
    }
    if (existed) {
      this.handleNodeDown(nodeId)
    }
  }

  /**
   * Host-triggered resync for all currently bound docs.
   *
   * @returns {Promise<void>}
   */
  async resyncAllDocs () {
    await Promise.all(Array.from(this.boundDocs.values(), state =>
      this.resyncDoc(state.namespace, state.docName).catch(err => {
        console.error('cluster resync failed', `${state.namespace}:${state.docName}`, err)
      })
    ))
  }

  /**
   * @param {string} docKey
   * @param {Array<string>} aliveNodes
   * @returns {string | null}
   */
  resolveSyncNode (docKey, aliveNodes) {
    const isValidCandidate = candidate => (
      typeof candidate === 'string' &&
      candidate.length > 0 &&
      candidate !== this.nodeId &&
      aliveNodes.includes(candidate)
    )

    if (this.chooseSyncNode !== null) {
      const selectedByHook = this.chooseSyncNode(docKey, aliveNodes, this.syncNode)
      if (isValidCandidate(selectedByHook)) {
        return selectedByHook
      }
    }

    if (isValidCandidate(this.syncNode)) {
      return this.syncNode
    }

    const fallback = aliveNodes
      .filter(node => node !== this.nodeId)
      .sort()[0]
    return typeof fallback === 'string' ? fallback : null
  }

  /**
   * @param {BoundDocState} state
   * @param {string} ownerNodeId
   * @param {Array<number>} changedClients
   */
  updateAwarenessOwnership (state, ownerNodeId, changedClients) {
    let ownerSet = state.ownedAwarenessClientsByNode.get(ownerNodeId)
    if (ownerSet === undefined) {
      ownerSet = new Set()
      state.ownedAwarenessClientsByNode.set(ownerNodeId, ownerSet)
    }

    changedClients.forEach(clientId => {
      const current = state.awareness.getStates().get(clientId)
      if (current === undefined) {
        state.ownedAwarenessClientsByNode.forEach(clientSet => {
          clientSet.delete(clientId)
        })
        return
      }

      state.ownedAwarenessClientsByNode.forEach((clientSet, nodeId) => {
        if (nodeId !== ownerNodeId) {
          clientSet.delete(clientId)
        }
      })
      ownerSet.add(clientId)
    })
  }
}

export { YjsNatsCluster }
