import { NatsBus } from './nats-bus.js'
import { createSubjectFormatter } from './nats-subject.js'
import { YjsNatsCluster } from './yjs-nats-cluster.js'
import { setClusterSync } from './utils-docs.js'

/**
 * @typedef {import('./types.js').CreateClusterSyncOptions} CreateClusterSyncOptions
 * @typedef {import('./types.js').BusMessageMeta} BusMessageMeta
 */

/** @type {YDocClusterSyncAdapter|null} */
let activeYdocCluster = null

class NatsConnectionBus {
  /**
   * @param {{
   * nc: any,
   * nodeId: string,
   * subjectTemplate?: { broadcast: string, unicast: string },
   * requestTimeoutMs?: number,
   * maxRetries?: number,
   * closeNatsOnClose?: boolean
   * }} options
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
   * @returns {Promise<void>}
   */
  async connect () {}

  /**
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
   * @param {string} topic
   * @param {Uint8Array} payload
   * @returns {Promise<void>}
   */
  async publish (topic, payload) {
    this.nc.publish(this.broadcastSubject(topic), payload)
  }

  /**
   * @param {string} topic
   * @param {(payload: Uint8Array, meta: BusMessageMeta) => void | Promise<void>} handler
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
   * @param {string} targetNodeId
   * @param {string} method
   * @param {Uint8Array} payload
   * @param {{ timeoutMs?: number, retries?: number }} [opts]
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
   * @param {string} method
   * @param {(payload: Uint8Array, meta: BusMessageMeta) => Uint8Array | Promise<Uint8Array>} handler
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
   * @param {any} sub
   * @param {(msg: any) => void | Promise<void>} handler
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
   * @param {string} topic
   */
  broadcastSubject (topic) {
    return this.subjectFormatter.broadcastSubject(topic)
  }

  /**
   * @param {string} nodeId
   * @param {string} method
   */
  unicastSubject (nodeId, method) {
    return this.subjectFormatter.unicastSubject(nodeId, method)
  }
}

class YDocClusterSyncAdapter {
  /**
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
   * @param {string} namespace
   * @param {string} docName
   * @param {import('yjs').Doc} doc
   * @param {import('@y/protocols/awareness').Awareness} awareness
   * @returns {Promise<any>}
   */
  async bindDoc (namespace, docName, doc, awareness) {
    await this.connect()
    return this.cluster.bindDoc(namespace, docName, doc, awareness)
  }

  /**
   * @param {string} namespace
   * @param {string} docName
   * @returns {Promise<void>}
   */
  async unbindDoc (namespace, docName) {
    await this.cluster.unbindDoc(namespace, docName)
  }

  /**
   * @param {string} namespace
   * @param {string} docName
   * @returns {Promise<boolean>}
   */
  async resyncDoc (namespace, docName) {
    return this.cluster.resyncDoc(namespace, docName)
  }

  /**
   * @param {string | null | undefined} syncNode
   * @param {Array<string>} nodeIds
   */
  setNodes (syncNode, nodeIds) {
    this.cluster.setNodes(syncNode, nodeIds)
  }

  /**
   * @param {string} nodeId
   */
  removeNode (nodeId) {
    this.cluster.removeNode(nodeId)
  }

  /**
   * @returns {Promise<void>}
   */
  async resyncAllDocs () {
    await this.cluster.resyncAllDocs()
  }
}

/**
 * @param {CreateClusterSyncOptions} options
 * @returns {YDocClusterSyncAdapter}
 */
const setupYdocCluster = options => {
  const clusterSync = new YDocClusterSyncAdapter(options)
  activeYdocCluster = clusterSync
  setClusterSync(clusterSync)
  return clusterSync
}

/**
 * @returns {YDocClusterSyncAdapter|null}
 */
const getYdocCluster = () => activeYdocCluster

export { setupYdocCluster, getYdocCluster, NatsBus }
