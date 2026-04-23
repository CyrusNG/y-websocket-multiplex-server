/**
 * A minimal DocSyncTransport implementation for websocket server fanout.
 * Inbound sync messages are still handled by the ws sync protocol path.
 */

/**
 * @typedef {import('./types.js').WsDocTransportOptions} WsDocTransportOptions
 */

class WsDocTransport {
  /**
   * Creates a lightweight transport that fans out updates over websocket connections.
   *
   * @param {WsDocTransportOptions} options
   */
  constructor ({ onPublishUpdate, onPublishAwareness }) {
    this.onPublishUpdate = onPublishUpdate
    this.onPublishAwareness = onPublishAwareness
  }

  /**
   * No-op subscription hook for API compatibility with clustered transports.
   *
   * @returns {Promise<() => void>}
   */
  async subscribeDoc () {
    return () => {}
  }

  /**
   * Forwards a doc update payload to the websocket fanout callback.
   *
   * @param {string} _docKey
   * @param {string} _senderNodeId
   * @param {Uint8Array} update
   */
  async publishUpdate (_docKey, _senderNodeId, update) {
    await this.onPublishUpdate(update)
  }

  /**
   * Forwards an awareness payload to the websocket fanout callback.
   *
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
   * Throws because websocket fanout transport does not support pull-based sync requests.
   *
   * @returns {Promise<Uint8Array>}
   */
  async requestSync () {
    throw new Error('WsDocTransport does not support requestSync')
  }
}

export { WsDocTransport }
