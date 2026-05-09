import * as awarenessProtocol from '@y/protocols/awareness'
import { AwarenessClusterState, encodeAwarenessEntries } from './awareness-cluster-state.js'
import { DocSyncEngine } from './doc-sync-engine.js'
import { NatsDocTransport } from './nats-doc-transport.js'

/**
 * @typedef {import('./types.js').YjsNatsClusterOptions} YjsNatsClusterOptions
 * @typedef {import('./types.js').BoundDocState} BoundDocState
 * @typedef {import('./types.js').ClusterBoundDocRef} ClusterBoundDocRef
 * @typedef {import('./types.js').OptionalNodeId} OptionalNodeId
 * @typedef {import('yjs').Doc} YDoc
 */

const ORIGIN_CLUSTER = Symbol('yjs-nats-cluster-origin')
let awarenessRoundSeq = 0
const createAwarenessRoundId = nodeId => `${nodeId}:${Date.now().toString(36)}:${(awarenessRoundSeq++).toString(36)}`

/**
 * Best-effort detection for NATS "No Responders" errors.
 *
 * @param {any} err
 * @returns {boolean}
 */
const isNatsNoResponders = err => {
  if (err === null || typeof err !== 'object') {
    return false
  }
  const code = typeof err.code === 'string' ? err.code : ''
  const message = typeof err.message === 'string' ? err.message : ''
  return code === '503' || message.includes('503') || /no responders/i.test(message)
}

/**
 * Builds a stable key for one namespaced document.
 */
const getDocKey = (namespace, docName) => `${namespace}-${docName}`
class YjsNatsCluster {
  /**
   * Creates a clustered sync runtime backed by bus transport and per-doc engines.
   *
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
    this.awarenessState = new AwarenessClusterState({ nodeId: this.nodeId })
    this.unsubAwarenessSnapshots = null
    this.unsubAwarenessSolicits = null
    this.debugAwareness = process.env.DEBUG_AWARENESS_CLUSTER === '1'
    /** @type {Map<string, Set<string>>} */
    this.respondedAwarenessRoundsByDoc = new Map()

    /** @type {Map<string, BoundDocState>} */
    this.boundDocs = new Map()
    this.resyncIntervalId = null
  }

  /**
   * Replies with this node's local awareness snapshot when we first observe
   * a remote node become present for this doc (e.g. client reconnect/rebind).
   *
   * @param {BoundDocState} state
   * @param {string} docKey
   * @param {string} senderNodeId
   * @param {number} beforeClientCount
   */
  maybeBackfillLocalAwarenessToSender (state, docKey, senderNodeId, beforeClientCount) {
    if (senderNodeId === this.nodeId) {
      return
    }
    const afterClientCount = this.awarenessState.getSnapshotClientIds(docKey, senderNodeId).length
    if (!(beforeClientCount === 0 && afterClientCount > 0)) {
      return
    }

    this.awarenessState.refreshLocalOwnership(state)
    this.awarenessState.upsertLocalSnapshotFromAwareness(state, docKey)
    const snapshotEntries = this.awarenessState.getSnapshotEntries(docKey, this.nodeId)
    if (snapshotEntries.length === 0) {
      return
    }
    const snapshotUpdate = encodeAwarenessEntries(snapshotEntries)
    const changedClients = snapshotEntries.map(item => item.clientId)
    state.engine.transport.publishAwareness(docKey, this.nodeId, snapshotUpdate, changedClients).catch(err => {
      console.error('cluster awareness reconnect backfill broadcast failed', `${state.namespace}:${state.docName}`, err)
    })
    this.transport.publishAwarenessSnapshot(docKey, this.nodeId, snapshotUpdate, changedClients).catch(err => {
      console.error('cluster awareness reconnect backfill global snapshot failed', `${state.namespace}:${state.docName}`, err)
    })
  }

  /**
   * Prunes remembered solicitation rounds to cap memory growth.
   *
   * @param {string} docKey
   */
  pruneRespondedRounds (docKey) {
    const rounds = this.respondedAwarenessRoundsByDoc.get(docKey)
    if (rounds === undefined || rounds.size <= 256) {
      return
    }
    const kept = new Set(Array.from(rounds).slice(-128))
    this.respondedAwarenessRoundsByDoc.set(docKey, kept)
  }

  /**
   * Publishes this node's locally-owned awareness shard for one doc.
   *
   * @param {BoundDocState} state
   * @param {string} docKey
   * @returns {Promise<void>}
   */
  async publishLocalAwarenessShard (state, docKey) {
    this.awarenessState.refreshLocalOwnership(state)
    this.awarenessState.upsertLocalSnapshotFromAwareness(state, docKey)
    const snapshotEntries = this.awarenessState.getSnapshotEntries(docKey, this.nodeId)
    if (snapshotEntries.length === 0) {
      return
    }
    const snapshotUpdate = encodeAwarenessEntries(snapshotEntries)
    const changedClients = snapshotEntries.map(item => item.clientId)
    await state.engine.transport.publishAwareness(docKey, this.nodeId, snapshotUpdate, changedClients)
    await this.transport.publishAwarenessSnapshot(docKey, this.nodeId, snapshotUpdate, changedClients)
  }

  /**
   * Broadcasts a cluster-wide solicitation and publishes local shard immediately.
   *
   * @param {BoundDocState} state
   * @param {string} docKey
   * @returns {Promise<void>}
   */
  async runAwarenessAntiEntropyRound (state, docKey) {
    const roundId = createAwarenessRoundId(this.nodeId)
    await this.transport.publishAwarenessSolicit(docKey, this.nodeId, roundId)
    let rounds = this.respondedAwarenessRoundsByDoc.get(docKey)
    if (rounds === undefined) {
      rounds = new Set()
      this.respondedAwarenessRoundsByDoc.set(docKey, rounds)
    }
    rounds.add(roundId)
    this.pruneRespondedRounds(docKey)
    await this.publishLocalAwarenessShard(state, docKey)
  }

  /**
   * Connects to the bus and starts periodic resync when configured.
   *
   * @returns {Promise<void>}
   */
  async connect () {
    await this.bus.connect()
    if (this.unsubAwarenessSnapshots === null) {
      this.unsubAwarenessSnapshots = await this.transport.subscribeAwarenessSnapshots((docKey, senderNodeId, awarenessUpdate, changedClients) => {
        const beforeRemoteClientCount = this.awarenessState.getSnapshotClientIds(docKey, senderNodeId).length
        this.awarenessState.upsertSnapshot(docKey, senderNodeId, awarenessUpdate)
        const state = this.boundDocs.get(docKey)
        if (this.debugAwareness) {
          console.log('[aw-debug] cluster apply snapshot?', {
            nodeId: this.nodeId,
            docKey,
            senderNodeId,
            hasBoundDoc: state !== undefined,
            changedClients
          })
        }
        if (state === undefined || senderNodeId === this.nodeId || !this.aliveNodes.has(senderNodeId)) {
          return
        }
        state.engine.syncCore.applyRemoteAwarenessUpdate(awarenessUpdate)
        this.awarenessState.updateOwnershipFromChanges(state, senderNodeId, changedClients)
        this.maybeBackfillLocalAwarenessToSender(state, docKey, senderNodeId, beforeRemoteClientCount)
      })
    }
    if (this.unsubAwarenessSolicits === null) {
      this.unsubAwarenessSolicits = await this.transport.subscribeAwarenessSolicits((docKey, requesterNodeId, roundId) => {
        const state = this.boundDocs.get(docKey)
        if (state === undefined) {
          return
        }
        let rounds = this.respondedAwarenessRoundsByDoc.get(docKey)
        if (rounds === undefined) {
          rounds = new Set()
          this.respondedAwarenessRoundsByDoc.set(docKey, rounds)
        }
        if (rounds.has(roundId)) {
          return
        }
        rounds.add(roundId)
        this.pruneRespondedRounds(docKey)
        this.publishLocalAwarenessShard(state, docKey).catch(err => {
          console.error('cluster awareness anti-entropy shard publish failed', `${state.namespace}:${state.docName}`, requesterNodeId, err)
        })
      })
    }
    if (this.resyncIntervalMs > 0 && this.resyncIntervalId === null) {
      this.resyncIntervalId = setInterval(() => {
        this.boundDocs.forEach((state, docKey) => {
          this.runAwarenessAntiEntropyRound(state, docKey).catch(err => {
            console.error('cluster awareness anti-entropy round failed', docKey, err)
          })
          this.resyncDoc(state.namespace, state.docName).catch(err => {
            console.error('cluster resync failed', docKey, err)
          })
        })
      }, this.resyncIntervalMs)
    }
  }

  /**
   * Stops periodic tasks, destroys bound-doc engines, and closes bus resources.
   *
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
    if (this.unsubAwarenessSnapshots !== null) {
      this.unsubAwarenessSnapshots()
      this.unsubAwarenessSnapshots = null
    }
    if (this.unsubAwarenessSolicits !== null) {
      this.unsubAwarenessSolicits()
      this.unsubAwarenessSolicits = null
    }
    this.respondedAwarenessRoundsByDoc.clear()
    await this.bus.close()
  }

  /**
   * Binds a document into clustered sync and returns a destroy handle.
   *
   * @param {string} namespace
   * @param {string} docName
   * @param {YDoc} doc
   * @param {awarenessProtocol.Awareness} awareness
   * @returns {Promise<ClusterBoundDocRef>}
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
      isClusterOrigin: origin =>
        origin === ORIGIN_CLUSTER ||
        (origin !== null &&
          typeof origin === 'object' &&
          (origin.source === 'cluster' || origin.source === 'catchup')),
      onRemoteAwareness: (senderNodeId, awarenessUpdate, changedClients) => {
        const beforeRemoteClientCount = this.awarenessState.getSnapshotClientIds(docKey, senderNodeId).length
        this.awarenessState.upsertSnapshot(docKey, senderNodeId, awarenessUpdate)
        this.awarenessState.updateOwnershipFromChanges(state, senderNodeId, changedClients)
        this.maybeBackfillLocalAwarenessToSender(state, docKey, senderNodeId, beforeRemoteClientCount)
      },
      shouldAcceptRemoteNode: senderNodeId => this.aliveNodes.has(senderNodeId)
    })

    this.boundDocs.set(docKey, state)
    this.awarenessState.hydrateAwarenessFromSnapshots(state, docKey, ORIGIN_CLUSTER)

    await state.engine.connect()
    this.awarenessState.refreshLocalOwnership(state)
    this.awarenessState.upsertLocalSnapshotFromAwareness(state, docKey)
    this.runAwarenessAntiEntropyRound(state, docKey).catch(err => {
      console.error('cluster bind awareness anti-entropy round failed', `${ns}:${docName}`, err)
    })

    const localAwarenessObserver = ({ added, updated, removed }, origin) => {
      if (state.engine.syncCore.isClusterOrigin(origin)) {
        return
      }
      const changedClients = Array.from(new Set(added.concat(updated, removed)))
      if (changedClients.length > 0) {
        this.awarenessState.updateOwnershipFromChanges(state, this.nodeId, changedClients)
        const localUpdate = awarenessProtocol.encodeAwarenessUpdate(state.awareness, changedClients)
        this.awarenessState.upsertSnapshot(docKey, this.nodeId, localUpdate)
        this.transport.publishAwarenessSnapshot(docKey, this.nodeId, localUpdate, changedClients).catch(err => {
          console.error('cluster awareness snapshot publish failed', `${state.namespace}:${state.docName}`, err)
        })
      }
    }
    awareness.on('update', localAwarenessObserver)
    state.unsubs.push(() => {
      awareness.off('update', localAwarenessObserver)
    })

    // Trigger an eager catch-up in background. A transient "no responders" on
    // fresh topology should not fail bindDoc for local websocket traffic.
    this.resyncDoc(ns, docName).catch(err => {
      if (isNatsNoResponders(err)) {
        return
      }
      console.error('cluster initial resync failed', `${ns}:${docName}`, err)
    })

    return {
      namespace: ns,
      docName,
      destroy: async () => {
        await this.unbindDoc(ns, docName)
      }
    }
  }

  /**
   * Unbinds and destroys sync state for one document.
   *
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
    this.awarenessState.dropDocSnapshots(docKey)
  }

  /**
   * Performs a one-shot resync for one bound document.
   *
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
    const candidateNodes = this.resolveSyncNodeCandidates(docKey, aliveNodes)
    if (candidateNodes.length === 0) {
      return false
    }

    let lastErr = null
    for (let i = 0; i < candidateNodes.length; i++) {
      const targetNode = candidateNodes[i]
      try {
        await state.engine.resyncFrom(targetNode)
        return true
      } catch (err) {
        lastErr = err
      }
    }
    throw /** @type {Error} */ (lastErr)
  }

  /**
   * Removes awareness state owned by a node that just went down.
   *
   * @param {string} nodeId
   */
  handleNodeDown (nodeId) {
    this.boundDocs.forEach(state => {
      this.awarenessState.refreshLocalOwnership(state)
      const removedByOwnership = state.ownedAwarenessClientsByNode.get(nodeId)
      const removedBySnapshot = this.awarenessState.getSnapshotClientIds(getDocKey(state.namespace, state.docName), nodeId)
      const removed = new Set([...(removedByOwnership || new Set()), ...removedBySnapshot])
      if (removed.size === 0) {
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
    this.awarenessState.dropNodeSnapshots(nodeId)
  }

  /**
   * Pushes the latest node topology snapshot from the host runtime.
   *
   * @param {OptionalNodeId} syncNode
   * @param {Array<string>} nodeIds
   */
  setNodes (syncNode, nodeIds) {
    const prevNodes = this.aliveNodes
    const nextNodes = new Set(nodeIds.filter(nodeId => typeof nodeId === 'string' && nodeId.length > 0))
    nextNodes.add(this.nodeId)
    prevNodes.forEach(nodeId => {
      if (!nextNodes.has(nodeId)) {
        this.handleNodeDown(nodeId)
      }
    })
    this.syncNode = typeof syncNode === 'string' && syncNode.length > 0 ? syncNode : null
    this.aliveNodes = nextNodes

    const hasRemoteNodeJoin = Array.from(nextNodes).some(nodeId => nodeId !== this.nodeId && !prevNodes.has(nodeId))
    this.awarenessState.markAliveNodes(Array.from(nextNodes))
    if (hasRemoteNodeJoin) {
      this.boundDocs.forEach(state => {
        const docKey = getDocKey(state.namespace, state.docName)
        this.runAwarenessAntiEntropyRound(state, docKey).catch(err => {
          console.error('cluster topology awareness anti-entropy round failed', `${state.namespace}:${state.docName}`, err)
        })
      })
    }
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
   * Resolves which node to sync from for a given doc.
   *
   * @param {string} docKey
   * @param {Array<string>} aliveNodes
   * @returns {string | null}
   */
  resolveSyncNode (docKey, aliveNodes) {
    const candidates = this.resolveSyncNodeCandidates(docKey, aliveNodes)
    return candidates.length > 0 ? candidates[0] : null
  }

  /**
   * Resolves ordered sync candidates for a given doc.
   *
   * @param {string} docKey
   * @param {Array<string>} aliveNodes
   * @returns {Array<string>}
   */
  resolveSyncNodeCandidates (docKey, aliveNodes) {
    const isValidCandidate = candidate => (
      typeof candidate === 'string' &&
      candidate.length > 0 &&
      candidate !== this.nodeId &&
      aliveNodes.includes(candidate)
    )

    /** @type {Array<string>} */
    const ordered = []
    const pushUnique = candidate => {
      if (!isValidCandidate(candidate) || ordered.includes(candidate)) {
        return
      }
      ordered.push(candidate)
    }

    if (this.chooseSyncNode !== null) {
      const selectedByHook = this.chooseSyncNode(docKey, aliveNodes, this.syncNode)
      pushUnique(selectedByHook)
    }

    pushUnique(this.syncNode)

    const fallbacks = aliveNodes
      .filter(node => node !== this.nodeId)
      .sort()
    fallbacks.forEach(pushUnique)
    return ordered
  }
}

export { YjsNatsCluster }
