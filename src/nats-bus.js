import { connect } from 'nats'
import { createSubjectFormatter } from './nats-subject.js'

/**
 * @typedef {import('./types.js').NatsBusOptions} NatsBusOptions
 * @typedef {import('./types.js').BusMessageMeta} BusMessageMeta
 * @typedef {import('./types.js').BusRequestOptions} BusRequestOptions
 * @typedef {import('./types.js').BusSubscribeHandler} BusSubscribeHandler
 * @typedef {import('./types.js').BusHandleHandler} BusHandleHandler
 * @typedef {import('./types.js').SubscriptionMessageHandler} SubscriptionMessageHandler
 */

const noopUnsub = () => {}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * Encodes a UTF-8 string to a Uint8Array payload.
 *
 * @param {string} message
 * @returns {Uint8Array}
 */
const encodeText = message => textEncoder.encode(message)

/**
 * Decodes a UTF-8 payload to a string.
 *
 * @param {Uint8Array} payload
 * @returns {string}
 */
const decodeText = payload => textDecoder.decode(payload)

class NatsBus {
  /**
   * Creates a NATS message bus abstraction used by cluster sync modules.
   *
   * @param {NatsBusOptions} opts
   */
  constructor ({
    nodeId,
    connectOptions = {},
    subjectTemplate,
    requestTimeoutMs = 1500,
    maxRetries = 2
  }) {
    this.nodeId = nodeId
    this.connectOptions = connectOptions
    this.requestTimeoutMs = requestTimeoutMs
    this.maxRetries = maxRetries
    this.subjectFormatter = createSubjectFormatter({
      subjectTemplate
    })

    /** @type {any | null} */
    this.nc = null

    /** @type {Set<any>} */
    this.subscriptions = new Set()
  }

  /**
   * Opens the NATS connection if it is not already connected.
   *
   * @returns {Promise<void>}
   */
  async connect () {
    if (this.nc !== null) {
      return
    }
    const connectOptions = { ...this.connectOptions }
    const resolvedServers = connectOptions.servers
    if (!resolvedServers || (Array.isArray(resolvedServers) && resolvedServers.length === 0)) {
      throw new Error('NatsBus requires `connectOptions.servers`')
    }
    connectOptions.servers = resolvedServers
    this.nc = await connect(connectOptions)
  }

  /**
   * Closes all subscriptions and the underlying NATS connection.
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
    if (this.nc !== null) {
      await this.nc.close()
      this.nc = null
    }
  }

  /**
   * Publishes a payload to a logical broadcast topic.
   *
   * @param {string} topic
   * @param {Uint8Array} payload
   * @returns {Promise<void>}
   */
  async publish (topic, payload) {
    const nc = this.assertConnection()
    nc.publish(this.broadcastSubject(topic), payload)
  }

  /**
   * Subscribes to a logical broadcast topic.
   *
   * @param {string} topic
   * @param {BusSubscribeHandler} handler
   * @returns {Promise<() => void>}
   */
  async subscribe (topic, handler) {
    const nc = this.assertConnection()
    const sub = nc.subscribe(this.broadcastSubject(topic))
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
   * Sends a request payload to a target node and waits for a response.
   *
   * @param {string} targetNodeId
   * @param {string} method
   * @param {Uint8Array} payload
   * @param {BusRequestOptions} [opts]
   * @returns {Promise<Uint8Array>}
   */
  async request (targetNodeId, method, payload, opts = {}) {
    const nc = this.assertConnection()
    const retries = opts.retries ?? this.maxRetries
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs
    let lastErr = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await nc.request(this.unicastSubject(targetNodeId, method), payload, { timeout: timeoutMs })
        return response.data
      } catch (err) {
        lastErr = err
      }
    }
    throw /** @type {Error} */ (lastErr)
  }

  /**
   * Registers a request handler on this node for a given method.
   *
   * @param {string} method
   * @param {BusHandleHandler} handler
   * @returns {Promise<() => void>}
   */
  async handle (method, handler) {
    const nc = this.assertConnection()
    const subject = this.unicastSubject(this.nodeId, method)
    const sub = nc.subscribe(subject)
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
   * Consumes async subscription messages and dispatches each one to the handler.
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
   * Returns the active NATS connection or throws when disconnected.
   *
   * @returns {any}
   */
  assertConnection () {
    if (this.nc === null) {
      throw new Error('NatsBus is not connected')
    }
    return this.nc
  }

  /**
   * Resolves a broadcast subject name for the given logical topic.
   *
   * @param {string} topic
   */
  broadcastSubject (topic) {
    return this.subjectFormatter.broadcastSubject(topic)
  }

  /**
   * Resolves a unicast subject name for node and method values.
   *
   * @param {string} nodeId
   * @param {string} method
   */
  unicastSubject (nodeId, method) {
    return this.subjectFormatter.unicastSubject(nodeId, method)
  }
}

const createNoopUnsub = () => noopUnsub

const decodeBusText = decodeText
const encodeBusText = encodeText

export { NatsBus, createNoopUnsub, decodeBusText, encodeBusText }
