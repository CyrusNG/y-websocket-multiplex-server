import * as syncProtocol from '@y/protocols/sync'
import * as awarenessProtocol from '@y/protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as broadcastchannel from 'lib0/broadcastchannel'

/**
 * @typedef {import('./types.js').Listener} Listener
 * @typedef {import('./types.js').AwarenessChanges} AwarenessChanges
 * @typedef {import('./types.js').MultiplexSocketManagerOptions} MultiplexSocketManagerOptions
 * @typedef {import('./types.js').MultiplexProviderOptions} MultiplexProviderOptions
 * @typedef {import('./types.js').MultiplexAttachOptions} MultiplexAttachOptions
 * @typedef {import('./types.js').StringMap} StringMap
 * @typedef {import('./types.js').SocketMessageData} SocketMessageData
 * @typedef {import('./types.js').MaybeAwareness} MaybeAwareness
 * @typedef {import('./types.js').AwarenessRemovalScope} AwarenessRemovalScope
 * @typedef {import('./types.js').MaybeWebSocket} MaybeWebSocket
 * @typedef {import('yjs').Doc} YDoc
 * @typedef {string | MultiplexBinding} DocNameOrBinding
 */

const messageSync = 0
const messageAwareness = 1
const messageRoute = 2
const messageRouteClose = 3

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1

class Observable {
  /**
   * Creates a tiny event emitter for provider lifecycle events.
   */
  constructor () {
    /**
     * @type {Map<string, Set<Listener>>}
     */
    this.listeners = new Map()
  }

  /**
   * Registers a listener for an event.
   *
   * @param {string} eventName
   * @param {Listener} listener
   */
  on (eventName, listener) {
    const listeners = this.listeners.get(eventName) || new Set()
    listeners.add(listener)
    this.listeners.set(eventName, listeners)
  }

  /**
   * Removes a listener from an event.
   *
   * @param {string} eventName
   * @param {Listener} listener
   */
  off (eventName, listener) {
    const listeners = this.listeners.get(eventName)
    if (listeners !== undefined) {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(eventName)
      }
    }
  }

  /**
   * Emits an event with positional arguments.
   *
   * @param {string} eventName
   * @param {Array<any>} args
   */
  emit (eventName, args) {
    const listeners = this.listeners.get(eventName)
    if (listeners !== undefined) {
      listeners.forEach(listener => {
        listener(...args)
      })
    }
  }
}

/**
 * Builds the multiplex websocket URL for one namespace and query set.
 *
 * @param {string} serverUrl
 * @param {string} namespace
 * @param {StringMap} params
 */
const createProviderUrl = (serverUrl, namespace, params) => {
  const normalizedServerUrl = serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`
  const url = new URL(namespace, normalizedServerUrl)
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value)
  })
  url.searchParams.set('multiplex', 'true')
  return url.toString()
}

/**
 * Encodes a routed websocket payload for a target doc name.
 *
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
 * Encodes a route-close control message for a target doc name.
 *
 * @param {string} docName
 */
const encodeRouteCloseMessage = docName => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageRouteClose)
  encoding.writeVarString(encoder, docName)
  return encoding.toUint8Array(encoder)
}

/**
 * Builds a broadcast-channel key for a provider/doc pair.
 *
 * @param {string} providerUrl
 * @param {string} docName
 */
const createBroadcastChannelName = (providerUrl, docName) => `${providerUrl}#${docName}`

/**
 * Copies a Uint8Array into a plain ArrayBuffer.
 *
 * @param {Uint8Array} message
 */
const toArrayBuffer = message => {
  const bytes = new Uint8Array(message.byteLength)
  bytes.set(message)
  return bytes.buffer
}

const socketManagers = new Map()

/**
 * Extracts client IDs that carry null awareness state payloads.
 *
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

class MultiplexSocketManager {
  /**
   * Creates the shared physical websocket manager for a provider URL.
   *
   * @param {string} serverUrl
   * @param {MultiplexSocketManagerOptions} options
   */
  constructor (serverUrl, { maxBackoffTime, protocols, WebSocketPolyfill }) {
    this.serverUrl = serverUrl
    this.maxBackoffTime = maxBackoffTime
    this.protocols = protocols
    this.WebSocketPolyfill = WebSocketPolyfill
    /**
     * @type {Set<MultiplexBinding>}
     */
    this.providers = new Set()
    /**
     * @type {WebSocket|null}
     */
    this.ws = null
    this.shouldConnect = false
    this.reconnectDelay = 1000
    this.reconnectTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null)
  }

  /**
   * Opens or reuses a websocket connection and attaches socket handlers.
   */
  connect () {
    this.shouldConnect = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws !== null && (this.ws.readyState === wsReadyStateConnecting || this.ws.readyState === wsReadyStateOpen)) {
      return
    }
    const ws = this.protocols !== undefined
      ? new this.WebSocketPolyfill(this.serverUrl, this.protocols)
      : new this.WebSocketPolyfill(this.serverUrl)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      if (this.ws !== ws) {
        return
      }
      this.reconnectDelay = 1000
      this.getConnectedProviders().forEach(provider => {
        provider.emit('status', [{ status: 'connected' }])
        provider.resubscribe()
      })
    }
    ws.onmessage = event => {
      if (this.ws !== ws) {
        return
      }
      this.handleMessage(event.data)
    }
    ws.onerror = event => {
      if (this.ws !== ws) {
        return
      }
      this.getConnectedProviders().forEach(provider => {
        provider.emit('connection-error', [event, provider])
      })
    }
    ws.onclose = event => {
      if (this.ws !== ws) {
        return
      }
      this.ws = null
      this.getConnectedProviders().forEach(provider => {
        provider.setSynced(false)
        provider.removeAwarenessStates('remote')
        provider.emit('status', [{ status: 'disconnected' }])
        provider.emit('connection-close', [event, provider])
      })
      if (this.shouldConnect && this.getConnectedProviders().length > 0) {
        this.scheduleReconnect()
      }
    }
    this.ws = ws
  }

  /**
   * Schedules an exponential-backoff reconnect attempt.
   */
  scheduleReconnect () {
    if (this.reconnectTimer !== null) {
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxBackoffTime)
  }

  /**
   * Syncs physical websocket state with active logical bindings.
   */
  refreshConnectionState () {
    const hasConnectedProviders = this.getConnectedProviders().length > 0
    this.shouldConnect = hasConnectedProviders
    if (hasConnectedProviders) {
      this.connect()
      return
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws !== null) {
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * Disposes the manager when no bindings remain.
   */
  disconnectIfUnused () {
    if (this.providers.size === 0) {
      this.shouldConnect = false
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      if (this.ws !== null) {
        this.ws.close()
        this.ws = null
      }
      socketManagers.delete(this.serverUrl)
    }
  }

  /**
   * Registers a binding on this shared websocket manager.
   *
   * @param {MultiplexBinding} provider
   */
  addProvider (provider) {
    this.providers.add(provider)
    this.refreshConnectionState()
  }

  /**
   * Unregisters a binding from this shared websocket manager.
   *
   * @param {MultiplexBinding} provider
   */
  removeProvider (provider) {
    this.providers.delete(provider)
    this.disconnectIfUnused()
    if (this.providers.size > 0) {
      this.refreshConnectionState()
    }
  }

  /**
   * Returns bindings that currently expect an active connection.
   */
  getConnectedProviders () {
    return Array.from(this.providers).filter(provider => provider.isActive())
  }

  /**
   * Decodes one socket frame and routes doc payloads to matching bindings.
   *
   * @param {SocketMessageData} data
   */
  handleMessage (data) {
    if (typeof data === 'string' || data instanceof Blob) {
      return
    }
    const decoder = decoding.createDecoder(new Uint8Array(data))
    if (decoding.readVarUint(decoder) !== messageRoute) {
      return
    }
    const docName = decoding.readVarString(decoder)
    const message = decoding.readVarUint8Array(decoder)
    this.getConnectedProviders().forEach(provider => {
      if (provider.docName === docName) {
        provider.handleMessage(message)
      }
    })
  }

  /**
   * Sends a routed message to the server for one doc binding.
   *
   * @param {string} docName
   * @param {Uint8Array} message
   */
  sendRouteMessage (docName, message) {
    const ws = this.ws
    if (ws !== null && ws.readyState === wsReadyStateOpen) {
      ws.send(toArrayBuffer(encodeRouteMessage(docName, message)))
    }
  }

  /**
   * Sends a route-close control frame when no active binding uses the doc.
   *
   * @param {string} docName
   */
  closeRoute (docName) {
    const ws = this.ws
    if (ws !== null && ws.readyState === wsReadyStateOpen) {
      const hasOtherConnectedProvider = this.getConnectedProviders().some(provider => provider.docName === docName)
      if (!hasOtherConnectedProvider) {
        ws.send(toArrayBuffer(encodeRouteCloseMessage(docName)))
      }
    }
  }
}

/**
 * Returns a cached socket manager (or creates one) for a provider URL.
 *
 * @param {string} serverUrl
 * @param {MultiplexSocketManagerOptions} options
 */
const getSocketManager = (serverUrl, options) => {
  const existing = socketManagers.get(serverUrl)
  if (existing !== undefined) {
    return existing
  }
  const manager = new MultiplexSocketManager(serverUrl, options)
  socketManagers.set(manager.serverUrl, manager)
  return manager
}

class MultiplexBinding extends Observable {
  /**
   * Creates one logical doc binding over the shared provider websocket.
   *
   * @param {MultiplexProvider} provider
   * @param {string} docName
   * @param {YDoc} doc
   * @param {MaybeAwareness} awareness
   * @param {boolean} connect
   * @param {boolean} disableBc
   * @param {number} resyncInterval
   */
  constructor (provider, docName, doc, awareness, connect, disableBc, resyncInterval) {
    super()
    this.provider = provider
    this.docName = docName
    this.doc = doc
    this.awareness = awareness
    this.shouldConnect = connect
    this.disableBc = disableBc
    this.resyncInterval = resyncInterval
    this.broadcastChannel = createBroadcastChannelName(this.provider.url, this.docName)
    this.synced = false
    this.reconnectAwarenessState = null
    this.resyncIntervalId = /** @type {ReturnType<typeof setInterval>|null} */ (null)
    this.bcSubscriber = (
      /** @type {ArrayBuffer | Uint8Array} */ data,
      /** @type {any} */ origin
    ) => {
      if (origin !== this) {
        const message = data instanceof Uint8Array ? data : new Uint8Array(data)
        this.handleMessage(message, false)
      }
    }

    this.docUpdateHandler = (
      /** @type {Uint8Array} */ update,
      /** @type {any} */ origin
    ) => {
      if (origin !== this) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.writeUpdate(encoder, update)
        const message = encoding.toUint8Array(encoder)
        this.publishMessage(message)
      }
    }

    this.awarenessUpdateHandler = (
      /** @type {AwarenessChanges} */ changes,
      /** @type {any} */ origin
    ) => {
      const awareness = this.awareness
      if (awareness !== null && changes.removed.length > 0) {
        changes.removed.forEach(clientID => {
          if (clientID !== this.doc.clientID) {
            awareness.meta.delete(clientID)
          }
        })
      }
      if (origin !== this && awareness !== null) {
        const changedClients = changes.added.concat(changes.updated, changes.removed)
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, messageAwareness)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
        )
        const message = encoding.toUint8Array(encoder)
        this.publishMessage(message)
      }
    }

    if (!this.disableBc) {
      broadcastchannel.subscribe(this.broadcastChannel, this.bcSubscriber)
    }
    this.doc.on('update', this.docUpdateHandler)
    if (this.awareness !== null) {
      this.awareness.on('update', this.awarenessUpdateHandler)
    }
    this.startResyncInterval()
  }

  /**
   * Returns whether this binding should currently participate in sync.
   */
  isActive () {
    return this.provider.shouldConnect && this.shouldConnect
  }

  /**
   * Enables this binding and resubscribes if websocket is already open.
   */
  connect () {
    this.shouldConnect = true
    this.provider.wsManager.refreshConnectionState()
    if (this.provider.wsManager.ws !== null && this.provider.wsManager.ws.readyState === wsReadyStateOpen) {
      this.emit('status', [{ status: 'connected' }])
      this.resubscribe()
    }
  }

  /**
   * Disables this binding and removes remote awareness state.
   */
  disconnect () {
    this.shouldConnect = false
    this.setSynced(false)
    if (this.awareness !== null) {
      const localState = this.awareness.getLocalState()
      if (localState !== null) {
        this.reconnectAwarenessState = localState
        awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], null)
      }
    }
    this.removeAwarenessStates('remote')
    this.provider.wsManager.closeRoute(this.docName)
    this.provider.wsManager.refreshConnectionState()
  }

  /**
   * Fully tears down this binding and detaches all listeners/resources.
   */
  destroy () {
    this.disconnect()
    this.reconnectAwarenessState = null
    this.stopResyncInterval()
    if (!this.disableBc) {
      broadcastchannel.unsubscribe(this.broadcastChannel, this.bcSubscriber)
    }
    this.removeAwarenessStates('all')
    this.doc.off('update', this.docUpdateHandler)
    if (this.awareness !== null) {
      this.awareness.off('update', this.awarenessUpdateHandler)
    }
    this.provider.bindings.delete(this.docName)
    this.provider.wsManager.removeProvider(this)
    super.emit('destroy', [this])
  }

  /**
   * Sends sync step1 and local awareness state to resubscribe this binding.
   */
  resubscribe () {
    if (!this.isActive()) {
      return
    }
    if (this.awareness !== null && this.awareness.getLocalState() === null && this.reconnectAwarenessState !== null) {
      this.awareness.setLocalState(this.reconnectAwarenessState)
    }
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    this.publishMessage(encoding.toUint8Array(encoder))
    this.publishLocalAwareness('resubscribe')
  }

  /**
   * Publishes current local awareness state with a fresh awareness clock.
   *
   * @param {string} reason
   */
  publishLocalAwareness (reason) {
    if (this.awareness === null) {
      return
    }
    let awarenessState = this.awareness.getLocalState()
    if (awarenessState === null) {
      return
    }
    // Refresh local awareness clock so peers can always accept the latest online state.
    this.awareness.setLocalState(awarenessState)
    awarenessState = this.awareness.getLocalState()
    if (awarenessState === null) {
      return
    }
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, messageAwareness)
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
    )
    this.publishMessage(encoding.toUint8Array(awarenessEncoder))
  }

  /**
   * Handles one routed sync/awareness message for this binding.
   *
   * @param {Uint8Array} message
   * @param {boolean} emitBc
   */
  handleMessage (message, emitBc = true) {
    const decoder = decoding.createDecoder(message)
    const encoder = encoding.createEncoder()
    const messageType = decoding.readVarUint(decoder)
    switch (messageType) {
      case messageSync:
      {
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, this)
        if (encoding.length(encoder) > 1) {
          const reply = encoding.toUint8Array(encoder)
          this.provider.wsManager.sendRouteMessage(this.docName, reply)
          if (emitBc && !this.disableBc) {
            broadcastchannel.publish(this.broadcastChannel, toArrayBuffer(reply), this)
          }
        }
        this.setSynced(true)
        break
      }
      case messageAwareness:
      {
        const awareness = this.awareness
        if (awareness !== null) {
          const awarenessUpdate = decoding.readVarUint8Array(decoder)
          const nullStateClients = getNullStateClients(awarenessUpdate)
          awarenessProtocol.applyAwarenessUpdate(
            awareness,
            awarenessUpdate,
            this
          )
          nullStateClients.forEach(clientID => {
            if (clientID !== this.doc.clientID) {
              awareness.meta.delete(clientID)
            }
          })
        }
        break
      }
    }
  }

  /**
   * Updates local sync flags and emits sync status events.
   *
   * @param {boolean} synced
   */
  setSynced (synced) {
    if (this.synced !== synced) {
      this.synced = synced
      this.emit('sync', [synced])
      this.emit('synced', [synced])
    }
  }

  /**
   * Removes awareness states by scope (local, remote, or all).
   *
   * @param {AwarenessRemovalScope} [scope]
   */
  removeAwarenessStates (scope = 'local') {
    const awareness = this.awareness
    if (awareness !== null) {
      const states = awareness.getStates()
      if (scope === 'local') {
        const localState = awareness.getLocalState()
        if (localState !== null) {
          awarenessProtocol.removeAwarenessStates(awareness, [this.doc.clientID], this)
        }
        return
      }
      const clients = Array.from(states.keys()).filter(clientID => scope === 'all' || clientID !== this.doc.clientID)
      if (clients.length > 0) {
        awarenessProtocol.removeAwarenessStates(awareness, clients, this)
        // Keep awareness clocks aligned with removed remote states so a peer
        // that reconnects with a reset/low clock is not ignored.
        clients.forEach(clientID => {
          if (clientID !== this.doc.clientID) {
            awareness.meta.delete(clientID)
          }
        })
      }
    }
  }

  /**
   * Starts periodic resubscribe pings when configured.
   */
  startResyncInterval () {
    if (this.resyncInterval > 0 && this.resyncIntervalId === null) {
      this.resyncIntervalId = setInterval(() => {
        if (this.isActive()) {
          this.resubscribe()
        }
      }, this.resyncInterval)
    }
  }

  /**
   * Stops the periodic resubscribe timer.
   */
  stopResyncInterval () {
    if (this.resyncIntervalId !== null) {
      clearInterval(this.resyncIntervalId)
      this.resyncIntervalId = null
    }
  }

  /**
   * Publishes a binding message to websocket and broadcast channel.
   *
   * @param {Uint8Array} message
   */
  publishMessage (message) {
    this.provider.wsManager.sendRouteMessage(this.docName, message)
    if (!this.disableBc) {
      broadcastchannel.publish(this.broadcastChannel, toArrayBuffer(message), this)
    }
  }
}

class MultiplexProvider {
  /**
   * Creates a multiplex provider that shares one websocket across docs.
   *
   * @param {string} serverUrl
   * @param {string} namespace
   * @param {MultiplexProviderOptions} [opts]
   */
  constructor (serverUrl, namespace, {
    connect = true,
    params = {},
    protocols,
    WebSocketPolyfill = /** @type {typeof WebSocket} */ (globalThis.WebSocket),
    maxBackoffTime = 10000
  } = {}) {
    if (WebSocketPolyfill == null) {
      throw new Error('MultiplexProvider requires a WebSocket implementation')
    }
    this.serverUrl = serverUrl
    this.namespace = namespace
    this.url = createProviderUrl(serverUrl, namespace, params)
    this.shouldConnect = connect
    /**
     * @type {Map<string, MultiplexBinding>}
     */
    this.bindings = new Map()
    this.wsManager = getSocketManager(this.url, { WebSocketPolyfill, protocols, maxBackoffTime })
  }

  /**
   * Returns the shared physical websocket used by this provider, or null before connect.
   *
   * @returns {MaybeWebSocket}
   */
  getWebSocket () {
    return this.wsManager.ws
  }

  /**
   * Attaches a doc to this provider and returns its logical binding.
   *
   * @param {string} docName
   * @param {YDoc} doc
   * @param {MultiplexAttachOptions} [opts]
   * @returns {MultiplexBinding}
   */
  attach (docName, doc, {
    awareness = false,
    connect = true,
    disableBc = false,
    resyncInterval = -1
  } = {}) {
    const existing = this.bindings.get(docName)
    if (existing !== undefined) {
      return existing
    }
    const resolvedAwareness = awareness === true
      ? new awarenessProtocol.Awareness(doc)
      : (awareness instanceof awarenessProtocol.Awareness ? awareness : null)
    const binding = new MultiplexBinding(this, docName, doc, resolvedAwareness, connect, disableBc, resyncInterval)
    this.bindings.set(docName, binding)
    this.wsManager.addProvider(binding)
    if (binding.isActive() && this.wsManager.ws !== null && this.wsManager.ws.readyState === wsReadyStateOpen) {
      binding.emit('status', [{ status: 'connected' }])
      binding.resubscribe()
    }
    return binding
  }

  /**
   * Detaches and destroys a binding by doc name or binding instance.
   *
   * @param {DocNameOrBinding} docNameOrBinding
   */
  detach (docNameOrBinding) {
    const binding = typeof docNameOrBinding === 'string'
      ? this.bindings.get(docNameOrBinding)
      : docNameOrBinding
    if (binding !== undefined) {
      binding.destroy()
    }
  }

  /**
   * Enables provider-level connectivity.
   */
  connect () {
    this.shouldConnect = true
    this.wsManager.refreshConnectionState()
  }

  /**
   * Disables provider-level connectivity for all bindings.
   */
  disconnect () {
    this.shouldConnect = false
    this.bindings.forEach(binding => {
      binding.setSynced(false)
      binding.removeAwarenessStates('remote')
      binding.emit('status', [{ status: 'disconnected' }])
    })
    this.wsManager.refreshConnectionState()
  }

  /**
   * Destroys all bindings associated with this provider.
   */
  destroy () {
    Array.from(this.bindings.values()).forEach(binding => {
      binding.destroy()
    })
  }
}

export { MultiplexProvider }
