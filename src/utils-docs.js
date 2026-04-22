import * as Y from 'yjs'
import * as syncProtocol from '@y/protocols/sync'
import * as awarenessProtocol from '@y/protocols/awareness'

import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as map from 'lib0/map'

import * as eventloop from 'lib0/eventloop'

import { callbackHandler, isCallbackSet } from './callback.js'
import { DocSyncEngine } from './doc-sync-engine.js'
import { WsDocTransport } from './ws-doc-transport.js'

/**
 * @typedef {import('./types.js').PersistenceAdapter} PersistenceAdapter
 * @typedef {import('./types.js').ClusterSyncRuntime} ClusterSyncRuntime
 */

const CALLBACK_DEBOUNCE_WAIT = parseInt(process.env.CALLBACK_DEBOUNCE_WAIT || '2000')
const CALLBACK_DEBOUNCE_MAXWAIT = parseInt(process.env.CALLBACK_DEBOUNCE_MAXWAIT || '10000')

const debouncer = eventloop.createDebouncer(CALLBACK_DEBOUNCE_WAIT, CALLBACK_DEBOUNCE_MAXWAIT)

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1

// disable gc when using snapshots!
const gcEnabled = process.env.GC !== 'false' && process.env.GC !== '0'

/** @type {PersistenceAdapter|null} */
let persistence = null
/** @type {ClusterSyncRuntime|null} */
let clusterSync = null

/** @type {Map<string,WSSharedDoc>} */
const docs = new Map()
/** @type {Map<import('ws').WebSocket, Map<string, { doc: WSSharedDoc, routeConn: any, initialized: Promise<void> }>>} */
const connectionDocs = new Map()
const docsBeingRemoved = new Set()

const messageSync = 0
const messageAwareness = 1
const messageRoute = 2
const messageRouteClose = 3

const createDocKey = (namespace, docName) => `${namespace}:${docName}`

const getRequestNamespace = req => {
  const url = new URL(req.url || '/', 'http://localhost')
  return url.pathname.replace(/^\/+|\/+$/g, '')
}

/** @type {(ydoc: Y.Doc) => Promise<void>} */
let contentInitializor = _ydoc => Promise.resolve()

const setPersistence = persistence_ => {
  persistence = normalizePersistence(persistence_)
}

const getPersistence = () => persistence

const setClusterSync = clusterSync_ => {
  clusterSync = clusterSync_
  if (clusterSync !== null && typeof clusterSync.connect === 'function') {
    Promise.resolve(clusterSync.connect()).catch(err => {
      console.error('cluster sync connect failed', err)
    })
  }
}

const getClusterSync = () => clusterSync

/** @param {PersistenceAdapter|null} persistence_ */
const normalizePersistence = persistence_ => {
  if (persistence_ == null) {
    return null
  }
  if (typeof persistence_.bindState === 'function' && typeof persistence_.unbindState === 'function') {
    return persistence_
  }
  throw new Error('Invalid persistence: expected { bindState, unbindState }')
}

const setContentInitializor = f => {
  contentInitializor = f
}

class WSSharedDoc extends Y.Doc {
  constructor (name, namespace, docName) {
    super({ gc: gcEnabled })
    this.name = name
    this.namespace = namespace
    this.docName = docName
    /** @type {Map<Object, Set<number>>} */
    this.conns = new Map()
    /** @type {awarenessProtocol.Awareness} */
    this.awareness = new awarenessProtocol.Awareness(this)
    this.awareness.setLocalState(null)
    this.remoteOrigin = Symbol('ws-shared-doc-remote-origin')
    this.syncEngine = new DocSyncEngine({
      doc: this,
      awareness: this.awareness,
      docKey: createDocKey(namespace, docName),
      nodeId: 'ws-local',
      transport: new WsDocTransport({
        onPublishUpdate: update => {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, messageSync)
          syncProtocol.writeUpdate(encoder, update)
          const message = encoding.toUint8Array(encoder)
          this.conns.forEach((_, conn) => send(this, conn, message))
        },
        onPublishAwareness: (awarenessUpdate, changedClients, conn) => {
          if (conn !== null && conn !== undefined) {
            const connControlledIDs = /** @type {Set<number>} */ (this.conns.get(conn))
            if (connControlledIDs !== undefined) {
              changedClients.forEach(clientID => {
                const state = this.awareness.getStates().get(clientID)
                if (state === undefined) {
                  connControlledIDs.delete(clientID)
                } else {
                  connControlledIDs.add(clientID)
                }
              })
            }
          }
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, messageAwareness)
          encoding.writeVarUint8Array(encoder, awarenessUpdate)
          const message = encoding.toUint8Array(encoder)
          this.conns.forEach((_, c) => {
            send(this, c, message)
          })
        }
      }),
      remoteOrigin: this.remoteOrigin,
      onRemoteAwareness: () => {}
    })
    this.syncEngine.connect().catch(err => {
      console.error('ws sync engine connect failed', err)
    })

    if (isCallbackSet) {
      this.on('update', (_update, _origin, doc) => {
        debouncer(() => callbackHandler(/** @type {WSSharedDoc} */ (doc)))
      })
    }
    this.whenInitialized = contentInitializor(this)
  }

  destroy () {
    this.syncEngine.destroy()
    super.destroy()
  }
}

const getOrCreateDoc = (namespace, docname, gc = true) => {
  const doc = map.setIfUndefined(docs, createDocKey(namespace, docname), () => {
    const created = new WSSharedDoc(createDocKey(namespace, docname), namespace, docname)
    created.gc = gc
    if (persistence !== null) {
      created.whenInitialized = Promise.all([
        created.whenInitialized,
        Promise.resolve(persistence.bindState(created.name, created))
      ]).then(() => undefined)
    }
    if (clusterSync !== null) {
      created.whenInitialized = Promise.all([
        created.whenInitialized,
        Promise.resolve(clusterSync.bindDoc(namespace, docname, created, created.awareness))
      ]).then(() => undefined)
    }
    docs.set(created.name, created)
    return created
  })
  doc.gc = gc
  return doc
}

const getDoc = (namespace, docName) => getOrCreateDoc(namespace, docName)

const getDocsForConnection = conn => {
  const routeConns = connectionDocs.get(conn)
  return routeConns === undefined ? [] : Array.from(routeConns.values(), ({ doc }) => doc)
}

const getConnectionsForDoc = (namespace, docName) => {
  const doc = docs.get(createDocKey(namespace, docName))
  return doc === undefined
    ? []
    : Array.from(new Set(Array.from(doc.conns.keys(), conn => conn.ws || conn)))
}

const cleanupDoc = doc => {
  if (docsBeingRemoved.has(doc.name)) {
    return
  }
  docsBeingRemoved.add(doc.name)
  docs.delete(doc.name)
  const cleanup = () => {
    doc.destroy()
    docsBeingRemoved.delete(doc.name)
  }

  const unbindCluster = Promise.resolve(
    clusterSync !== null && typeof clusterSync.unbindDoc === 'function'
      ? clusterSync.unbindDoc(doc.namespace, doc.docName)
      : undefined
  ).catch(err => {
    console.error('cluster sync unbind failed', err)
  })

  if (persistence !== null) {
    const persistence_ = persistence
    unbindCluster.finally(() => {
      persistence_.unbindState(doc.name, doc).finally(cleanup)
    })
    return
  }

  unbindCluster.finally(cleanup)
}

const cleanDoc = (namespace, docName) => {
  const doc = docs.get(createDocKey(namespace, docName))
  if (doc === undefined) {
    return false
  }
  if (doc.conns.size === 0) {
    cleanupDoc(doc)
    return true
  }
  Array.from(doc.conns.keys()).forEach(conn => {
    closeConn(doc, conn)
  })
  return true
}

const messageListener = (conn, doc, message) => {
  try {
    const encoder = encoding.createEncoder()
    const decoder = decoding.createDecoder(message)
    const messageType = decoding.readVarUint(decoder)
    switch (messageType) {
      case messageSync:
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder))
        }
        break
      case messageAwareness:
      {
        const awarenessUpdate = decoding.readVarUint8Array(decoder)
        const nullStateClients = getNullStateClients(awarenessUpdate)
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, awarenessUpdate, conn)
        nullStateClients.forEach(clientID => {
          if (clientID !== doc.clientID) {
            doc.awareness.meta.delete(clientID)
          }
        })
        break
      }
    }
  } catch (err) {
    console.error(err)
    // @ts-ignore
    doc.emit('error', [err])
  }
}

const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    // @ts-ignore
    const controlledIds = /** @type {Set<number>} */ (doc.conns.get(conn))
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null)
    controlledIds.forEach(clientID => {
      if (clientID !== doc.clientID) {
        doc.awareness.meta.delete(clientID)
      }
    })
    if (doc.conns.size === 0) {
      cleanupDoc(doc)
    }
  }
  conn.close()
}

const send = (doc, conn, message) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn)
  }
  try {
    conn.send(message, {}, err => { err != null && closeConn(doc, conn) })
  } catch (_err) {
    closeConn(doc, conn)
  }
}

const encodeRouteMessage = (docName, message) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageRoute)
  encoding.writeVarString(encoder, docName)
  encoding.writeVarUint8Array(encoder, message)
  return encoding.toUint8Array(encoder)
}

/**
 * @param {Uint8Array} awarenessUpdate
 * @returns {Array<number>}
 */
const getNullStateClients = awarenessUpdate => {
  const decoder = decoding.createDecoder(awarenessUpdate)
  const len = decoding.readVarUint(decoder)
  const removedClients = []
  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(decoder)
    decoding.readVarUint(decoder) // clock
    const state = JSON.parse(decoding.readVarString(decoder))
    if (state === null) {
      removedClients.push(clientID)
    }
  }
  return removedClients
}

const initializeConnection = async (doc, conn) => {
  try {
    await doc.whenInitialized
  } catch (err) {
    console.error(err)
    closeConn(doc, conn)
    return
  }
  doc.conns.set(conn, new Set())

  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, doc)
  send(doc, conn, encoding.toUint8Array(encoder))

  const awarenessStates = doc.awareness.getStates()
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, messageAwareness)
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys()))
    )
    send(doc, conn, encoding.toUint8Array(awarenessEncoder))
  }
}

export {
  setPersistence,
  getPersistence,
  setClusterSync,
  getClusterSync,
  setContentInitializor,
  WSSharedDoc,
  getDoc,
  getDocsForConnection,
  getConnectionsForDoc,
  cleanDoc,
  // internal for ws connection layer
  wsReadyStateConnecting,
  wsReadyStateOpen,
  messageRoute,
  messageRouteClose,
  connectionDocs,
  getOrCreateDoc,
  closeConn,
  messageListener,
  encodeRouteMessage,
  initializeConnection,
  getRequestNamespace
}
