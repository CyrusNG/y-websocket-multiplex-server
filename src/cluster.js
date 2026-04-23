import { NatsBus } from './nats-bus.js'
import { createSubjectFormatter } from './nats-subject.js'
import { YjsNatsCluster } from './yjs-nats-cluster.js'
import { setClusterSync } from './utils-docs.js'

/**
 * @typedef {import('./types.js').CreateClusterSyncOptions} CreateClusterSyncOptions
 * @typedef {import('./types.js').BusMessageMeta} BusMessageMeta
 * @typedef {import('./types.js').NatsConnectionBusOptions} NatsConnectionBusOptions
 * @typedef {import('./types.js').BusRequestOptions} BusRequestOptions
 * @typedef {import('./types.js').BusSubscribeHandler} BusSubscribeHandler
 * @typedef {import('./types.js').BusHandleHandler} BusHandleHandler
 * @typedef {import('./types.js').SubscriptionMessageHandler} SubscriptionMessageHandler
 * @typedef {import('./types.js').OptionalNodeId} OptionalNodeId
 * @typedef {import('yjs').Doc} YDoc
 * @typedef {import('@y/protocols/awareness').Awareness} Awareness
 */

class NatsConnectionBus {
  /**
   * Wraps an existing NATS connection with the cluster bus interface.
   *
   * @param {NatsConnectionBusOptions} options
   */
  constructor ({
    nc,
    nodeId,
    subjectTemplate,
    requestTimeoutMs = 1500,
    maxRetries = 2,
    closeNatsOnClose = false
  }) {
    this.nc = nc
    this.nodeId = nodeId
    this.requestTimeoutMs = requestTimeoutMs
    this.maxRetries = maxRetries
    this.closeNatsOnClose = closeNatsOnClose
    this.subjectFormatter = createSubjectFormatter({
      subjectTemplate
    })
    /** @type {Set<any>} */
    this.subscriptions = new Set()
  }

  /**
   * No-op connect for externally managed NATS connections.
   *
   * @returns {Promise<void>}
   */
  async connect () {}

  /**
   * Closes active subscriptions and optionally closes the shared NATS connection.
   *
   * @returns {Promise<void>}
   */
  async close () {
    this.subscriptions.forEach(sub => {
      try {
        sub.unsubscribe()
      } catch (_err) {
        // noop
      }
    })
    this.subscriptions.clear()
    if (this.closeNatsOnClose) {
      await this.nc.close()
    }
  }

  /**
   * Publishes a payload to a broadcast cluster topic.
   *
   * @param {string} topic
   * @param {Uint8Array} payload
   * @returns {Promise<void>}
   */
  async publish (topic, payload) {
    this.nc.publish(this.broadcastSubject(topic), payload)
  }

  /**
   * Subscribes to a broadcast cluster topic.
   *
   * @param {string} topic
   * @param {BusSubscribeHandler} handler
   * @returns {Promise<() => void>}
   */
  async subscribe (topic, handler) {
    const sub = this.nc.subscribe(this.broadcastSubject(topic))
    this.subscriptions.add(sub)
    this.consumeSubscription(sub, async msg => {
      await handler(msg.data, {
        subject: msg.subject,
        reply: msg.reply,
        headers: msg.headers,
        senderNodeId: null
      })
    })
    return () => {
      try {
        sub.unsubscribe()
      } finally {
        this.subscriptions.delete(sub)
      }
    }
  }

  /**
   * Sends a request to a target node and retries on failure.
   *
   * @param {string} targetNodeId
   * @param {string} method
   * @param {Uint8Array} payload
   * @param {BusRequestOptions} [opts]
   * @returns {Promise<Uint8Array>}
   */
  async request (targetNodeId, method, payload, opts = {}) {
    const retries = opts.retries ?? this.maxRetries
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs
    let lastErr = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.nc.request(this.unicastSubject(targetNodeId, method), payload, { timeout: timeoutMs })
        return response.data
      } catch (err) {
        lastErr = err
      }
    }
    throw /** @type {Error} */ (lastErr)
  }

  /**
   * Registers a request handler for this node on the given method.
   *
   * @param {string} method
   * @param {BusHandleHandler} handler
   * @returns {Promise<() => void>}
   */
  async handle (method, handler) {
    const sub = this.nc.subscribe(this.unicastSubject(this.nodeId, method))
    this.subscriptions.add(sub)
    this.consumeSubscription(sub, async msg => {
      if (!msg.reply) {
        return
      }
      const response = await handler(msg.data, {
        subject: msg.subject,
        reply: msg.reply,
        headers: msg.headers,
        senderNodeId: null
      })
      msg.respond(response)
    })
    return () => {
      try {
        sub.unsubscribe()
      } finally {
        this.subscriptions.delete(sub)
      }
    }
  }

  /**
   * Iterates an async subscription and invokes a handler for each message.
   *
   * @param {any} sub
   * @param {SubscriptionMessageHandler} handler
   */
  async consumeSubscription (sub, handler) {
    try {
      for await (const msg of sub) {
        await handler(msg)
      }
    } catch (_err) {
      // connection close / unsubscribe
    }
  }

  /**
   * Builds the broadcast subject for a logical topic.
   *
   * @param {string} topic
   */
  broadcastSubject (topic) {
    return this.subjectFormatter.broadcastSubject(topic)
  }

  /**
   * Builds the unicast subject for node and method.
   *
   * @param {string} nodeId
   * @param {string} method
   */
  unicastSubject (nodeId, method) {
    return this.subjectFormatter.unicastSubject(nodeId, method)
  }
}

class YDocClusterSyncAdapter {
  /**
   * Creates the runtime adapter that wires docs into NATS-backed cluster sync.
   *
   * @param {CreateClusterSyncOptions} options
   */
  constructor (options) {
    const natsOptions = options.nats || {}
    if (options.bus) {
      this.bus = options.bus
    } else if (natsOptions.connection) {
      this.bus = new NatsConnectionBus({
        nc: natsOptions.connection,
        nodeId: options.nodeId,
        subjectTemplate: natsOptions.subjectTemplate,
        requestTimeoutMs: natsOptions.requestTimeoutMs,
        maxRetries: natsOptions.maxRetries,
        closeNatsOnClose: natsOptions.closeNatsOnClose
      })
    } else {
      this.bus = new NatsBus({
        nodeId: options.nodeId,
        connectOptions: natsOptions.connectOptions,
        subjectTemplate: natsOptions.subjectTemplate,
        requestTimeoutMs: natsOptions.requestTimeoutMs,
        maxRetries: natsOptions.maxRetries
      })
    }
    this.cluster = new YjsNatsCluster({
      bus: this.bus,
      nodeId: options.nodeId,
      chooseSyncNode: options.chooseSyncNode,
      resyncIntervalMs: options.resyncIntervalMs
    })
    this.connected = false
  }

  /**
   * Connects cluster resources once and marks adapter as connected.
   *
   * @returns {Promise<void>}
   */
  async connect () {
    if (this.connected) {
      return
    }
    await this.cluster.connect()
    this.connected = true
  }

  /**
   * Closes cluster resources and marks adapter as disconnected.
   *
   * @returns {Promise<void>}
   */
  async close () {
    if (!this.connected) {
      return
    }
    await this.cluster.close()
    this.connected = false
  }

  /**
   * Binds a document to cluster sync and ensures connectivity first.
   *
   * @param {string} namespace
   * @param {string} docName
   * @param {YDoc} doc
   * @param {Awareness} awareness
   * @returns {Promise<any>}
   */
  async bindDoc (namespace, docName, doc, awareness) {
    await this.connect()
    return this.cluster.bindDoc(namespace, docName, doc, awareness)
  }

  /**
   * Unbinds a document from cluster sync.
   *
   * @param {string} namespace
   * @param {string} docName
   * @returns {Promise<void>}
   */
  async unbindDoc (namespace, docName) {
    await this.cluster.unbindDoc(namespace, docName)
  }

  /**
   * Triggers a one-shot resync for one document.
   *
   * @param {string} namespace
   * @param {string} docName
   * @returns {Promise<boolean>}
   */
  async resyncDoc (namespace, docName) {
    return this.cluster.resyncDoc(namespace, docName)
  }

  /**
   * Pushes the latest node topology snapshot to the cluster runtime.
   *
   * @param {OptionalNodeId} syncNode
   * @param {Array<string>} nodeIds
   */
  setNodes (syncNode, nodeIds) {
    this.cluster.setNodes(syncNode, nodeIds)
  }

  /**
   * Notifies the runtime that a node has been removed.
   *
   * @param {string} nodeId
   */
  removeNode (nodeId) {
    this.cluster.removeNode(nodeId)
  }

  /**
   * Triggers resync for all bound docs.
   *
   * @returns {Promise<void>}
   */
  async resyncAllDocs () {
    await this.cluster.resyncAllDocs()
  }
}

/**
 * Creates and installs a singleton cluster sync adapter.
 *
 * @param {CreateClusterSyncOptions} options
 * @returns {YDocClusterSyncAdapter}
 */
const setupYdocCluster = options => {
  const clusterSync = new YDocClusterSyncAdapter(options)
  setClusterSync(clusterSync)
  return clusterSync
}

export { setupYdocCluster, NatsBus }
