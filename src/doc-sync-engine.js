import * as awarenessProtocol from '@y/protocols/awareness'
import { createYDocSyncCore } from './sync-core.js'

/**
 * @typedef {import('./types.js').DocSyncEngineOptions} DocSyncEngineOptions
 */

/**
 * Deduplicates a number array while preserving insertion order.
 */
const uniqueNumbers = values => Array.from(new Set(values))
let updateSeq = 0
const createUpdateId = () => `${Date.now().toString(36)}-${(updateSeq++).toString(36)}`

class DocSyncEngine {
  /**
   * Creates a sync engine that bridges local doc events and transport messages.
   *
   * @param {DocSyncEngineOptions} options
   */
  constructor ({
    doc,
    awareness,
    docKey,
    nodeId,
    transport,
    remoteOrigin,
    isClusterOrigin,
    onRemoteAwareness
  }) {
    this.doc = doc
    this.awareness = awareness
    this.docKey = docKey
    this.nodeId = nodeId
    this.transport = transport
    this.onRemoteAwareness = onRemoteAwareness

    this.syncCore = createYDocSyncCore({
      doc,
      awareness,
      remoteOrigin,
      isClusterOrigin,
      onLocalUpdate: async (update, origin) => {
        await this.transport.publishUpdate(this.docKey, this.nodeId, update, origin)
      },
      onLocalAwarenessUpdate: async ({ added, updated, removed }, origin) => {
        const changedClients = uniqueNumbers(added.concat(updated, removed))
        if (changedClients.length === 0) {
          return
        }
        const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
        await this.transport.publishAwareness(
          this.docKey,
          this.nodeId,
          awarenessUpdate,
          changedClients,
          origin
        )
      }
    })

    this.unsubscribeTransport = null
  }

  /**
   * Connects transport subscriptions for remote updates and sync requests.
   *
   * @returns {Promise<void>}
   */
  async connect () {
    if (this.unsubscribeTransport !== null) {
      return
    }
    this.unsubscribeTransport = await this.transport.subscribeDoc(this.docKey, {
      onUpdate: (senderNodeId, update, updateId) => {
        if (senderNodeId === this.nodeId) {
          return
        }
        this.syncCore.applyRemoteUpdate(update, {
          source: 'cluster',
          meta: {
            senderNodeId,
            receiverNodeId: this.nodeId,
            docId: this.docKey,
            receivedAt: Date.now(),
            updateId: typeof updateId === 'string' && updateId.length > 0
              ? updateId
              : createUpdateId()
          }
        })
      },
      onAwareness: (senderNodeId, awarenessUpdate, changedClients) => {
        if (senderNodeId === this.nodeId) {
          return
        }
        this.syncCore.applyRemoteAwarenessUpdate(awarenessUpdate)
        this.onRemoteAwareness(senderNodeId, changedClients)
      },
      onSyncRequest: (_requesterNodeId, stateVector) => this.syncCore.encodeStateAsUpdate(stateVector)
    })
  }

  /**
   * Performs an on-demand resync from a specific target node.
   *
   * @param {string} targetNodeId
   * @returns {Promise<void>}
   */
  async resyncFrom (targetNodeId) {
    const stateVector = this.syncCore.encodeStateVector()
    const diff = await this.transport.requestSync(this.docKey, targetNodeId, this.nodeId, stateVector)
    this.syncCore.applyRemoteUpdate(diff, {
      source: 'catchup',
      meta: {
        senderNodeId: targetNodeId,
        receiverNodeId: this.nodeId,
        docId: this.docKey,
        receivedAt: Date.now(),
        updateId: createUpdateId()
      }
    })
  }

  /**
   * Tears down transport subscriptions and local sync listeners.
   */
  destroy () {
    if (this.unsubscribeTransport !== null) {
      this.unsubscribeTransport()
      this.unsubscribeTransport = null
    }
    this.syncCore.destroy()
  }
}

export { DocSyncEngine }
