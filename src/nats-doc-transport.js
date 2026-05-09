import {
  decodeMessage,
  encodeAwarenessMessage,
  encodeAwarenessSolicitMessage,
  encodeAwarenessSnapshotMessage,
  encodeSyncRequest,
  encodeSyncResponse,
  encodeUpdateMessage,
  getAwarenessSnapshotTopic,
  getAwarenessSolicitTopic,
  getAwarenessTopic,
  getSyncMethod,
  getUpdateTopic,
  MESSAGE_TYPE
} from './nats-protocol.js'

/**
 * @typedef {import('./types.js').NatsDocTransportOptions} NatsDocTransportOptions
 * @typedef {import('./types.js').DocSubscribeHandlers} DocSubscribeHandlers
 */

class NatsDocTransport {
  /**
   * Creates a NATS-backed transport adapter for doc sync messages.
   *
   * @param {NatsDocTransportOptions} options
   */
  constructor ({ bus }) {
    this.bus = bus
    this.debugAwareness = process.env.DEBUG_AWARENESS_CLUSTER === '1'
  }

  /**
   * Subscribes to update/awareness/sync channels for one document key.
   *
   * @param {string} docKey
   * @param {DocSubscribeHandlers} handlers
   * @returns {Promise<() => void>}
   */
  async subscribeDoc (docKey, handlers) {
    const unsubs = []

    unsubs.push(await this.bus.subscribe(getUpdateTopic(docKey), payload => {
      let parsed
      try {
        parsed = decodeMessage(payload)
      } catch (_err) {
        return
      }
      if (parsed.messageType !== MESSAGE_TYPE.UPDATE) {
        return
      }
      handlers.onUpdate(
        /** @type {string} */ (parsed.senderNodeId),
        /** @type {Uint8Array} */ (parsed.update),
        parsed.updateId
      )
    }))

    unsubs.push(await this.bus.subscribe(getAwarenessTopic(docKey), payload => {
      let parsed
      try {
        parsed = decodeMessage(payload)
      } catch (_err) {
        return
      }
      if (parsed.messageType !== MESSAGE_TYPE.AWARENESS) {
        return
      }
      handlers.onAwareness(
        /** @type {string} */ (parsed.senderNodeId),
        /** @type {Uint8Array} */ (parsed.awarenessUpdate),
        /** @type {Array<number>} */ (parsed.changedClients)
      )
    }))

    unsubs.push(await this.bus.handle(getSyncMethod(docKey), payload => {
      const parsed = decodeMessage(payload)
      if (parsed.messageType !== MESSAGE_TYPE.SYNC_REQUEST) {
        throw new Error('Unexpected sync request message type')
      }
      const diff = handlers.onSyncRequest(
        /** @type {string} */ (parsed.requesterNodeId),
        /** @type {Uint8Array} */ (parsed.stateVector)
      )
      return encodeSyncResponse(diff)
    }))

    return () => {
      unsubs.forEach(unsub => { unsub() })
    }
  }

  /**
   * Publishes a document update message to the cluster.
   *
   * @param {string} docKey
   * @param {string} senderNodeId
   * @param {Uint8Array} update
   * @param {any} origin
   */
  async publishUpdate (docKey, senderNodeId, update, origin) {
    const updateId = (
      origin !== null &&
      typeof origin === 'object' &&
      origin.meta !== null &&
      typeof origin.meta === 'object' &&
      typeof origin.meta.updateId === 'string'
    )
      ? origin.meta.updateId
      : undefined
    await this.bus.publish(getUpdateTopic(docKey), encodeUpdateMessage(senderNodeId, update, updateId))
  }

  /**
   * Publishes an awareness update message to the cluster.
   *
   * @param {string} docKey
   * @param {string} senderNodeId
   * @param {Uint8Array} awarenessUpdate
   * @param {Array<number>} changedClients
   */
  async publishAwareness (docKey, senderNodeId, awarenessUpdate, changedClients) {
    await this.bus.publish(
      getAwarenessTopic(docKey),
      encodeAwarenessMessage(senderNodeId, awarenessUpdate, changedClients)
    )
  }

  /**
   * Publishes a cluster-global awareness snapshot payload.
   *
   * @param {string} docKey
   * @param {string} senderNodeId
   * @param {Uint8Array} awarenessUpdate
   * @param {Array<number>} changedClients
   */
  async publishAwarenessSnapshot (docKey, senderNodeId, awarenessUpdate, changedClients) {
    if (this.debugAwareness) {
      console.log('[aw-debug] publish snapshot', { docKey, senderNodeId, changedClients })
    }
    await this.bus.publish(
      getAwarenessSnapshotTopic(),
      encodeAwarenessSnapshotMessage(docKey, senderNodeId, awarenessUpdate, changedClients)
    )
  }

  /**
   * Subscribes to cluster-global awareness snapshots.
   *
   * @param {(docKey: string, senderNodeId: string, awarenessUpdate: Uint8Array, changedClients: Array<number>) => void} handler
   * @returns {Promise<() => void>}
   */
  async subscribeAwarenessSnapshots (handler) {
    return this.bus.subscribe(getAwarenessSnapshotTopic(), payload => {
      let parsed
      try {
        parsed = decodeMessage(payload)
      } catch (_err) {
        return
      }
      if (parsed.messageType !== MESSAGE_TYPE.AWARENESS_SNAPSHOT) {
        return
      }
      if (this.debugAwareness) {
        console.log('[aw-debug] recv snapshot', {
          docKey: parsed.docKey,
          senderNodeId: parsed.senderNodeId,
          changedClients: parsed.changedClients
        })
      }
      handler(
        /** @type {string} */ (parsed.docKey),
        /** @type {string} */ (parsed.senderNodeId),
        /** @type {Uint8Array} */ (parsed.awarenessUpdate),
        /** @type {Array<number>} */ (parsed.changedClients)
      )
    })
  }

  /**
   * Publishes a cluster-global awareness snapshot solicitation.
   *
   * @param {string} docKey
   * @param {string} requesterNodeId
   * @param {string} roundId
   */
  async publishAwarenessSolicit (docKey, requesterNodeId, roundId) {
    await this.bus.publish(
      getAwarenessSolicitTopic(),
      encodeAwarenessSolicitMessage(docKey, requesterNodeId, roundId)
    )
  }

  /**
   * Subscribes to cluster-global awareness snapshot solicitations.
   *
   * @param {(docKey: string, requesterNodeId: string, roundId: string) => void} handler
   * @returns {Promise<() => void>}
   */
  async subscribeAwarenessSolicits (handler) {
    return this.bus.subscribe(getAwarenessSolicitTopic(), payload => {
      let parsed
      try {
        parsed = decodeMessage(payload)
      } catch (_err) {
        return
      }
      if (parsed.messageType !== MESSAGE_TYPE.AWARENESS_SOLICIT) {
        return
      }
      handler(
        /** @type {string} */ (parsed.docKey),
        /** @type {string} */ (parsed.requesterNodeId),
        /** @type {string} */ (parsed.roundId)
      )
    })
  }

  /**
   * Requests a sync diff from a target node using a state vector.
   *
   * @param {string} docKey
   * @param {string} targetNodeId
   * @param {string} requesterNodeId
   * @param {Uint8Array} stateVector
   * @returns {Promise<Uint8Array>}
   */
  async requestSync (docKey, targetNodeId, requesterNodeId, stateVector) {
    const responsePayload = await this.bus.request(
      targetNodeId,
      getSyncMethod(docKey),
      encodeSyncRequest(requesterNodeId, stateVector)
    )
    const parsed = decodeMessage(responsePayload)
    if (parsed.messageType !== MESSAGE_TYPE.SYNC_RESPONSE) {
      throw new Error('Unexpected sync response message type')
    }
    return /** @type {Uint8Array} */ (parsed.diffUpdate)
  }
}

export { NatsDocTransport }
