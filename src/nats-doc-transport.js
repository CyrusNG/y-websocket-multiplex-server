import {
  decodeMessage,
  encodeAwarenessMessage,
  encodeSyncRequest,
  encodeSyncResponse,
  encodeUpdateMessage,
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
      const parsed = decodeMessage(payload)
      if (parsed.messageType !== MESSAGE_TYPE.UPDATE) {
        return
      }
      handlers.onUpdate(
        /** @type {string} */ (parsed.senderNodeId),
        /** @type {Uint8Array} */ (parsed.update)
      )
    }))

    unsubs.push(await this.bus.subscribe(getAwarenessTopic(docKey), payload => {
      const parsed = decodeMessage(payload)
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
   */
  async publishUpdate (docKey, senderNodeId, update) {
    await this.bus.publish(getUpdateTopic(docKey), encodeUpdateMessage(senderNodeId, update))
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
