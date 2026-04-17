import { connect } from 'nats'

/**
 * @typedef {import('./types.js').NatsBusOptions} NatsBusOptions
 * @typedef {import('./types.js').BusMessageMeta} BusMessageMeta
 * @typedef {import('./types.js').BusRequestOptions} BusRequestOptions
 */

const noopUnsub = () => {}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * @param {string} value
 */
const encodeSubjectToken = value => Buffer.from(value).toString('base64url')

/**
 * @param {string} message
 * @returns {Uint8Array}
 */
const encodeText = message => textEncoder.encode(message)

/**
 * @param {Uint8Array} payload
 * @returns {string}
 */
const decodeText = payload => textDecoder.decode(payload)

class NatsBus {
  /**
   * @param {NatsBusOptions} opts
   */
  constructor ({
    nodeId,
    servers,
    connectOptions = {},
    prefix = 'yjs',
    requestTimeoutMs = 1500,
    maxRetries = 2
  }) {
    this.nodeId = nodeId
    this.servers = servers
    this.connectOptions = connectOptions
    this.prefix = prefix
    this.requestTimeoutMs = requestTimeoutMs
    this.maxRetries = maxRetries

    /** @type {any | null} */
    this.nc = null

    /** @type {Set<any>} */
    this.subscriptions = new Set()
  }

  /**
   * @returns {Promise<void>}
   */
  async connect () {
    if (this.nc !== null) {
      return
    }
    const connectOptions = { ...this.connectOptions }
    const resolvedServers = connectOptions.servers || this.servers
    if (!resolvedServers || (Array.isArray(resolvedServers) && resolvedServers.length === 0)) {
      throw new Error('NatsBus requires `servers` or `connectOptions.servers`')
    }
    connectOptions.servers = resolvedServers
    this.nc = await connect(connectOptions)
  }

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
    if (this.nc !== null) {
      await this.nc.close()
      this.nc = null
    }
  }

  /**
   * @param {string} topic
   * @param {Uint8Array} payload
   * @returns {Promise<void>}
   */
  async publish (topic, payload) {
    const nc = this.assertConnection()
    nc.publish(this.topicSubject(topic), payload)
  }

  /**
   * @param {string} topic
   * @param {(payload: Uint8Array, meta: BusMessageMeta) => void | Promise<void>} handler
   * @returns {Promise<() => void>}
   */
  async subscribe (topic, handler) {
    const nc = this.assertConnection()
    const sub = nc.subscribe(this.topicSubject(topic))
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
        const response = await nc.request(this.rpcSubject(targetNodeId, method), payload, { timeout: timeoutMs })
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
    const nc = this.assertConnection()
    const subject = this.rpcSubject(this.nodeId, method)
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
   * @returns {any}
   */
  assertConnection () {
    if (this.nc === null) {
      throw new Error('NatsBus is not connected')
    }
    return this.nc
  }

  /**
   * @param {string} topic
   */
  topicSubject (topic) {
    return `${this.prefix}.topic.${encodeSubjectToken(topic)}`
  }

  /**
   * @param {string} nodeId
   * @param {string} method
   */
  rpcSubject (nodeId, method) {
    return `${this.prefix}.node.${encodeSubjectToken(nodeId)}.rpc.${encodeSubjectToken(method)}`
  }
}

const createNoopUnsub = () => noopUnsub

const decodeBusText = decodeText
const encodeBusText = encodeText

export { NatsBus, createNoopUnsub, decodeBusText, encodeBusText }
