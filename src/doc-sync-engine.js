import * as awarenessProtocol from '@y/protocols/awareness'
import { createYDocSyncCore } from './sync-core.js'

/**
 * @typedef {import('./types.js').DocSyncEngineOptions} DocSyncEngineOptions
 */

const uniqueNumbers = values => Array.from(new Set(values))

class DocSyncEngine {
  /**
   * @param {DocSyncEngineOptions} options
   */
  constructor ({
    doc,
    awareness,
    docKey,
    nodeId,
    transport,
    remoteOrigin,
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
   * @returns {Promise<void>}
   */
  async connect () {
    if (this.unsubscribeTransport !== null) {
      return
    }
    this.unsubscribeTransport = await this.transport.subscribeDoc(this.docKey, {
      onUpdate: (senderNodeId, update) => {
        if (senderNodeId === this.nodeId) {
          return
        }
        this.syncCore.applyRemoteUpdate(update)
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
   * @param {string} targetNodeId
   * @returns {Promise<void>}
   */
  async resyncFrom (targetNodeId) {
    const stateVector = this.syncCore.encodeStateVector()
    const diff = await this.transport.requestSync(this.docKey, targetNodeId, this.nodeId, stateVector)
    this.syncCore.applyRemoteUpdate(diff)
  }

  destroy () {
    if (this.unsubscribeTransport !== null) {
      this.unsubscribeTransport()
      this.unsubscribeTransport = null
    }
    this.syncCore.destroy()
  }
}

export { DocSyncEngine }
