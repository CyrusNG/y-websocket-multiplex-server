import * as decoding from 'lib0/decoding'

import {
  closeConn,
  connectionDocs,
  encodeRouteMessage,
  getOrCreateDoc,
  getRequestNamespace,
  initializeConnection,
  messageListener,
  messageRoute,
  messageRouteClose,
  wsReadyStateConnecting,
  wsReadyStateOpen
} from './utils-docs.js'

const pingTimeout = 30000

const setupHeartbeat = conn => {
  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      try {
        conn.close()
      } catch (_err) {
        // ignore close errors
      }
      clearInterval(pingInterval)
      return
    }

    if (conn.readyState === wsReadyStateConnecting || conn.readyState === wsReadyStateOpen) {
      pongReceived = false
      try {
        conn.ping()
      } catch (_err) {
        try {
          conn.close()
        } catch (_closeErr) {
          // ignore close errors
        }
        clearInterval(pingInterval)
      }
      return
    }

    clearInterval(pingInterval)
  }, pingTimeout)

  conn.on('close', () => {
    clearInterval(pingInterval)
  })
  conn.on('pong', () => {
    pongReceived = true
  })
}

const setupMultiplexConnection = (conn, namespace, gc) => {
  /** @type {Map<string, { doc: import('./utils-docs.js').WSSharedDoc, routeConn: any, initialized: Promise<void> }>} */
  const routeConns = new Map()
  connectionDocs.set(conn, routeConns)

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
      send: (message, options, callback) => conn.send(encodeRouteMessage(docName, message), options, callback),
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

  const closeRouteConn = docName => {
    const routeState = routeConns.get(docName)
    if (routeState !== undefined) {
      routeConns.delete(docName)
      closeConn(routeState.doc, routeState.routeConn)
    }
  }

  conn.on('message', message => {
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

const setupWSConnection = (namespace, conn, req, opts = {}) => {
  const { gc = true } = opts
  conn.binaryType = 'arraybuffer'
  setupHeartbeat(conn)
  setupMultiplexConnection(conn, namespace || getRequestNamespace(req), gc)
}

export { setupWSConnection }
