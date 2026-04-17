import * as Y from 'yjs'
import * as awarenessProtocol from '@y/protocols/awareness'

/**
 * @typedef {import('./types.js').CreateYDocSyncCoreOptions} CreateYDocSyncCoreOptions
 * @typedef {import('./types.js').AwarenessChanges} AwarenessChanges
 */

/**
 * Shared Yjs sync behavior that can be reused by different transports (ws, nats, etc).
 */
class YDocSyncCore {
  /**
   * @param {CreateYDocSyncCoreOptions} options
   */
  constructor ({
    doc,
    awareness,
    remoteOrigin,
    onLocalUpdate,
    onLocalAwarenessUpdate
  }) {
    this.doc = doc
    this.awareness = awareness
    this.remoteOrigin = remoteOrigin
    this.onLocalUpdate = onLocalUpdate
    this.onLocalAwarenessUpdate = onLocalAwarenessUpdate

    this.handleDocUpdate = (update, origin) => {
      if (origin === this.remoteOrigin) {
        return
      }
      Promise.resolve(this.onLocalUpdate(update, origin)).catch(err => {
        console.error('sync core local update failed', err)
      })
    }

    this.handleAwarenessUpdate = (changes, origin) => {
      if (origin === this.remoteOrigin) {
        return
      }
      Promise.resolve(this.onLocalAwarenessUpdate(changes, origin)).catch(err => {
        console.error('sync core awareness update failed', err)
      })
    }

    this.doc.on('update', this.handleDocUpdate)
    this.awareness.on('update', this.handleAwarenessUpdate)
  }

  /**
   * @param {Uint8Array} update
   */
  applyRemoteUpdate (update) {
    Y.applyUpdate(this.doc, update, this.remoteOrigin)
  }

  /**
   * @param {Uint8Array} awarenessUpdate
   */
  applyRemoteAwarenessUpdate (awarenessUpdate) {
    awarenessProtocol.applyAwarenessUpdate(this.awareness, awarenessUpdate, this.remoteOrigin)
  }

  /**
   * @returns {Uint8Array}
   */
  encodeStateVector () {
    return Y.encodeStateVector(this.doc)
  }

  /**
   * @param {Uint8Array} stateVector
   * @returns {Uint8Array}
   */
  encodeStateAsUpdate (stateVector) {
    return Y.encodeStateAsUpdate(this.doc, stateVector)
  }

  destroy () {
    this.doc.off('update', this.handleDocUpdate)
    this.awareness.off('update', this.handleAwarenessUpdate)
  }
}

/**
 * @param {CreateYDocSyncCoreOptions} options
 */
const createYDocSyncCore = options => {
  return new YDocSyncCore(options)
}

export { createYDocSyncCore, YDocSyncCore }
