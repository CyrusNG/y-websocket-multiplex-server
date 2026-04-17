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

class NatsDocTransport {
  /**
   * @param {{ bus: import('./nats-bus.js').NatsBus }} options
   */
  constructor ({ bus }) {
    this.bus = bus
  }

  /**
   * @param {string} docKey
   * @param {{
   * onUpdate: (senderNodeId: string, update: Uint8Array) => void,
   * onAwareness: (senderNodeId: string, awarenessUpdate: Uint8Array, changedClients: Array<number>) => void,
   * onSyncRequest: (requesterNodeId: string, stateVector: Uint8Array) => Uint8Array
   * }} handlers
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
   * @param {string} docKey
   * @param {string} senderNodeId
   * @param {Uint8Array} update
   */
  async publishUpdate (docKey, senderNodeId, update) {
    await this.bus.publish(getUpdateTopic(docKey), encodeUpdateMessage(senderNodeId, update))
  }

  /**
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
