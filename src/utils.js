import * as Y from 'yjs'
import * as syncProtocol from '@y/protocols/sync'
import * as awarenessProtocol from '@y/protocols/awareness'

import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as map from 'lib0/map'

import * as eventloop from 'lib0/eventloop'

import { callbackHandler, isCallbackSet } from './callback.js'

const CALLBACK_DEBOUNCE_WAIT = parseInt(process.env.CALLBACK_DEBOUNCE_WAIT || '2000')
const CALLBACK_DEBOUNCE_MAXWAIT = parseInt(process.env.CALLBACK_DEBOUNCE_MAXWAIT || '10000')

const debouncer = eventloop.createDebouncer(CALLBACK_DEBOUNCE_WAIT, CALLBACK_DEBOUNCE_MAXWAIT)

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1
const wsReadyStateClosing = 2 // eslint-disable-line
const wsReadyStateClosed = 3 // eslint-disable-line

// disable gc when using snapshots!
const gcEnabled = process.env.GC !== 'false' && process.env.GC !== '0'
// const persistenceDir = process.env.YPERSISTENCE
/**
 * @type {{bindState: function(string,WSSharedDoc):(Promise<any>|any), unbindState:function(string,WSSharedDoc):(Promise<any>|any), provider: any}|null}
 */
let persistence = null

/**
 * @param {{bindState: function(string,WSSharedDoc):(Promise<any>|any),
 * unbindState:function(string,WSSharedDoc):(Promise<any>|any),provider:any}|null} persistence_
 */
export const setPersistence = persistence_ => {
  persistence = normalizePersistence(persistence_)
}

/**
 * @return {null|{bindState: function(string,WSSharedDoc):(Promise<any>|any),
  * unbindState:function(string,WSSharedDoc):(Promise<any>|any)}|null} used persistence layer
  */
export const getPersistence = () => persistence

/**
 * @param {any} persistence_
 */
const normalizePersistence = persistence_ => {
  if (persistence_ == null) {
    return null
  }
  if (typeof persistence_.bindState === 'function' && typeof persistence_.unbindState === 'function') {
    return persistence_
  }
  throw new Error('Invalid persistence: expected { bindState, unbindState }')
}

/**
 * @type {Map<string,WSSharedDoc>}
 */
const docs = new Map()
const connectionDocs = new Map()
const docsBeingRemoved = new Set()

const messageSync = 0
const messageAwareness = 1
const messageRoute = 2
const messageRouteClose = 3
// const messageAuth = 4

/**
 * @param {string} namespace
 * @param {string} docName
 */
const createDocKey = (namespace, docName) => `${namespace}:${docName}`

/**
 * @param {import('http').IncomingMessage} req
 */
const getRequestNamespace = req => {
  const url = new URL(req.url || '/', 'http://localhost')
  return url.pathname.replace(/^\/+|\/+$/g, '')
}

/**
 * @param {Uint8Array} update
 * @param {any} _origin
 * @param {WSSharedDoc} doc
 * @param {any} _tr
 */
const updateHandler = (update, _origin, doc, _tr) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeUpdate(encoder, update)
  const message = encoding.toUint8Array(encoder)
  doc.conns.forEach((_, conn) => send(doc, conn, message))
}

/**
 * @type {(ydoc: Y.Doc) => Promise<void>}
 */
let contentInitializor = _ydoc => Promise.resolve()

/**
 * This function is called once every time a Yjs document is created. You can
 * use it to pull data from an external source or initialize content.
 *
 * @param {(ydoc: Y.Doc) => Promise<void>} f
 */
export const setContentInitializor = (f) => {
  contentInitializor = f
}

export class WSSharedDoc extends Y.Doc {
  /**
   * @param {string} name
   * @param {string} namespace
   * @param {string} docName
   */
  constructor (name, namespace, docName) {
    super({ gc: gcEnabled })
    this.name = name
    this.namespace = namespace
    this.docName = docName
    /**
     * Maps from conn to set of controlled user ids. Delete all user ids from awareness when this conn is closed
     * @type {Map<Object, Set<number>>}
     */
    this.conns = new Map()
    /**
     * @type {awarenessProtocol.Awareness}
     */
    this.awareness = new awarenessProtocol.Awareness(this)
    this.awareness.setLocalState(null)
    /**
     * @param {{ added: Array<number>, updated: Array<number>, removed: Array<number> }} changes
     * @param {Object | null} conn Origin is the connection that made the change
     */
    const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed)
      if (conn !== null) {
        const connControlledIDs = /** @type {Set<number>} */ (this.conns.get(conn))
        if (connControlledIDs !== undefined) {
          added.forEach(clientID => { connControlledIDs.add(clientID) })
          removed.forEach(clientID => { connControlledIDs.delete(clientID) })
        }
      }
      // broadcast awareness update
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients))
      const buff = encoding.toUint8Array(encoder)
      this.conns.forEach((_, c) => {
        send(this, c, buff)
      })
    }
    this.awareness.on('update', awarenessChangeHandler)
    this.on('update', /** @type {any} */ (updateHandler))
    if (isCallbackSet) {
      this.on('update', (_update, _origin, doc) => {
        debouncer(() => callbackHandler(/** @type {WSSharedDoc} */ (doc)))
      })
    }
    this.whenInitialized = contentInitializor(this)
  }
}

/**
 * Gets or creates a Y.Doc by name, whether in memory or on disk
 *
 * @param {string} namespace - the namespace of the Y.Doc
 * @param {string} docname - the routed name of the Y.Doc to find or create
 * @param {boolean} gc - whether to allow gc on the doc (applies only when created)
 * @return {WSSharedDoc}
 */
const getOrCreateDoc = (namespace, docname, gc = true) => map.setIfUndefined(docs, createDocKey(namespace, docname), () => {
  const doc = new WSSharedDoc(createDocKey(namespace, docname), namespace, docname)
  doc.gc = gc
  if (persistence !== null) {
    doc.whenInitialized = Promise.all([
      doc.whenInitialized,
      Promise.resolve(persistence.bindState(doc.name, doc))
    ]).then(() => undefined)
  }
  docs.set(doc.name, doc)
  return doc
})

/**
 * @param {string} namespace
 * @param {string} docName
 * @return {WSSharedDoc}
 */
export const getDoc = (namespace, docName) => getOrCreateDoc(namespace, docName)

/**
 * @param {import('ws').WebSocket} conn
 * @return {Array<WSSharedDoc>}
 */
export const getDocsForConnection = conn => {
  const routeConns = connectionDocs.get(conn)
  return routeConns === undefined ? [] : Array.from(routeConns.values(), ({ doc }) => doc)
}

/**
 * @param {string} namespace
 * @param {string} docName
 * @return {Array<any>}
 */
export const getConnectionsForDoc = (namespace, docName) => {
  const doc = docs.get(createDocKey(namespace, docName))
  return doc === undefined
    ? []
    : Array.from(new Set(Array.from(doc.conns.keys(), conn => conn.ws || conn)))
}

/**
 * @param {WSSharedDoc} doc
 */
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
  if (persistence !== null) {
    persistence.unbindState(doc.name, doc).finally(cleanup)
  } else {
    cleanup()
  }
}

/**
 * @param {string} namespace
 * @param {string} docName
 */
export const cleanDoc = (namespace, docName) => {
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

/**
 * @param {any} conn
 * @param {WSSharedDoc} doc
 * @param {Uint8Array} message
 */
const messageListener = (conn, doc, message) => {
  try {
    const encoder = encoding.createEncoder()
    const decoder = decoding.createDecoder(message)
    const messageType = decoding.readVarUint(decoder)
    switch (messageType) {
      case messageSync:
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn)

        // If the `encoder` only contains the type of reply message and no
        // message, there is no need to send the message. When `encoder` only
        // contains the type of reply, its length is 1.
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder))
        }
        break
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn)
        break
      }
    }
  } catch (err) {
    console.error(err)
    // @ts-ignore
    doc.emit('error', [err])
  }
}

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 */
const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    /**
     * @type {Set<number>}
     */
    // @ts-ignore
    const controlledIds = doc.conns.get(conn)
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null)
    if (doc.conns.size === 0) {
      cleanupDoc(doc)
    }
  }
  conn.close()
}

/**
 * @param {WSSharedDoc} doc
 * @param {import('ws').WebSocket} conn
 * @param {Uint8Array} m
 */
const send = (doc, conn, m) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn)
  }
  try {
    conn.send(m, {}, err => { err != null && closeConn(doc, conn) })
  } catch (e) {
    closeConn(doc, conn)
  }
}

const pingTimeout = 30000

/**
 * @param {string} docName
 * @param {Uint8Array} message
 */
const encodeRouteMessage = (docName, message) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageRoute)
  encoding.writeVarString(encoder, docName)
  encoding.writeVarUint8Array(encoder, message)
  return encoding.toUint8Array(encoder)
}

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 */
const initializeConnection = async (doc, conn) => {
  try {
    await doc.whenInitialized
  } catch (err) {
    console.error(err)
    closeConn(doc, conn)
    return
  }
  doc.conns.set(conn, new Set())
  {
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
}

/**
 * @param {import('ws').WebSocket} conn
 */
const setupHeartbeat = conn => {
  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      try {
        conn.close()
      } catch (e) {
        // ignore close errors
      }
      clearInterval(pingInterval)
    } else if (conn.readyState === wsReadyStateConnecting || conn.readyState === wsReadyStateOpen) {
      pongReceived = false
      try {
        conn.ping()
      } catch (e) {
        try {
          conn.close()
        } catch (closeError) {
          // ignore close errors
        }
        clearInterval(pingInterval)
      }
    } else {
      clearInterval(pingInterval)
    }
  }, pingTimeout)

  conn.on('close', () => {
    clearInterval(pingInterval)
  })
  conn.on('pong', () => {
    pongReceived = true
  })
}

/**
 * @param {import('ws').WebSocket} conn
 * @param {string} namespace
 * @param {boolean} gc
 */
const setupMultiplexConnection = (conn, namespace, gc) => {
  /**
   * @type {Map<string, { doc: WSSharedDoc, routeConn: any, initialized: Promise<void> }>}
   */
  const routeConns = new Map()
  connectionDocs.set(conn, routeConns)

  /**
   * @param {string} docName
   */
  const getOrCreateRouteConn = docName => {
    const current = routeConns.get(docName)
    if (current !== undefined) {
      return current
    }
    const doc = getOrCreateDoc(namespace, docName, gc)
    const routeConn = {
      ws: conn,
      get readyState () {
        return conn.readyState
      },
      send: (
        /** @type {Uint8Array} */ message,
        /** @type {any} */ options,
        /** @type {(err?: Error | null) => void} */ callback
      ) => conn.send(encodeRouteMessage(docName, message), options, callback),
      close: () => {
        closeRouteConn(docName)
      }
    }
    const routeState = {
      doc,
      routeConn,
      initialized: initializeConnection(doc, routeConn)
    }
    routeConns.set(docName, routeState)
    return routeState
  }

  /**
   * @param {string} docName
   */
  const closeRouteConn = docName => {
    const routeState = routeConns.get(docName)
    if (routeState !== undefined) {
      routeConns.delete(docName)
      closeConn(routeState.doc, routeState.routeConn)
    }
  }

  conn.on('message', /** @param {ArrayBuffer} message */ message => {
    try {
      const decoder = decoding.createDecoder(new Uint8Array(message))
      const messageType = decoding.readVarUint(decoder)
      if (messageType === messageRouteClose) {
        closeRouteConn(decoding.readVarString(decoder))
        return
      }
      if (messageType !== messageRoute) {
        return
      }
      const docName = decoding.readVarString(decoder)
      const routedMessage = decoding.readVarUint8Array(decoder)
      const routeState = getOrCreateRouteConn(docName)
      routeState.initialized.then(() => {
        messageListener(routeState.routeConn, routeState.doc, routedMessage)
      })
    } catch (err) {
      console.error(err)
    }
  })

  conn.on('close', () => {
    routeConns.forEach(({ doc, routeConn }) => {
      closeConn(doc, routeConn)
    })
    routeConns.clear()
    connectionDocs.delete(conn)
  })
}

/**
 * @param {string | undefined} namespace
 * @param {import('ws').WebSocket} conn
 * @param {import('http').IncomingMessage} req
 * @param {{ gc?: boolean }} [opts]
 */
export const setupWSConnection = (namespace, conn, req, opts = {}) => {
  const { gc = true } = opts
  conn.binaryType = 'arraybuffer'
  setupHeartbeat(conn)
  setupMultiplexConnection(conn, namespace || getRequestNamespace(req), gc)
}
