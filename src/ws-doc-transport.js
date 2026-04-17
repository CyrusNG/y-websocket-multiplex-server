/**
 * A minimal DocSyncTransport implementation for websocket server fanout.
 * Inbound sync messages are still handled by the ws sync protocol path.
 */
class WsDocTransport {
  /**
   * @param {{
   * onPublishUpdate: (update: Uint8Array) => Promise<void> | void,
   * onPublishAwareness: (awarenessUpdate: Uint8Array, changedClients: Array<number>, origin: any) => Promise<void> | void
   * }} options
   */
  constructor ({ onPublishUpdate, onPublishAwareness }) {
    this.onPublishUpdate = onPublishUpdate
    this.onPublishAwareness = onPublishAwareness
  }

  /**
   * @returns {Promise<() => void>}
   */
  async subscribeDoc () {
    return () => {}
  }

  /**
   * @param {string} _docKey
   * @param {string} _senderNodeId
   * @param {Uint8Array} update
   */
  async publishUpdate (_docKey, _senderNodeId, update) {
    await this.onPublishUpdate(update)
  }

  /**
   * @param {string} _docKey
   * @param {string} _senderNodeId
   * @param {Uint8Array} awarenessUpdate
   * @param {Array<number>} changedClients
   * @param {any} origin
   */
  async publishAwareness (_docKey, _senderNodeId, awarenessUpdate, changedClients, origin) {
    await this.onPublishAwareness(awarenessUpdate, changedClients, origin)
  }

  /**
   * @returns {Promise<Uint8Array>}
   */
  async requestSync () {
    throw new Error('WsDocTransport does not support requestSync')
  }
}

export { WsDocTransport }
