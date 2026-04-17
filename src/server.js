#!/usr/bin/env node

import WebSocket from 'ws'
import http from 'http'
import * as number from 'lib0/number'
import { setupWSConnection } from './utils-connection.js'
import { setClusterSync } from './utils-docs.js'
import { setupYdocCluster } from './cluster.js'

const parseNatsServers = rawValue => rawValue
  .split(',')
  .map(server => server.trim())
  .filter(server => server.length > 0)

const createClusterSyncFromEnv = ({ host, port, env = process.env }) => {
  const natsServers = parseNatsServers(env.NATS_SERVERS || '')
  if (natsServers.length === 0) {
    return null
  }
  return setupYdocCluster({
    nodeId: env.NATS_NODE_ID || `${host}:${port}:${process.pid}`,
    servers: natsServers,
    prefix: env.NATS_PREFIX || 'yjs',
    defaultNamespace: env.NATS_NAMESPACE || 'default',
    resyncIntervalMs: number.parseInt(env.NATS_RESYNC_INTERVAL || '30000')
  })
}

class WebsocketServerRuntime {
  /**
   * @param {{
   * host?: string,
   * port?: number,
   * namespace?: string,
   * gc?: boolean,
   * clusterSync?: import('./types.js').ClusterSyncRuntime | null
   * }} [options]
   */
  constructor (options = {}) {
    const {
      host = 'localhost',
      port = 1234,
      namespace,
      gc = true,
      clusterSync = null
    } = options

    this.host = host
    this.port = port
    this.namespace = namespace
    this.gc = gc

    if (clusterSync !== null) {
      setClusterSync(clusterSync)
    }

    this.wss = new WebSocket.Server({ noServer: true })
    this.server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end('okay')
    })

    this.wss.on('connection', (ws, request) => {
      setupWSConnection(this.namespace, ws, request, { gc: this.gc })
    })

    this.server.on('upgrade', (request, socket, head) => {
      // You may check auth of request here..
      // Call `wss.HandleUpgrade` *after* you checked whether the client has access
      // (e.g. by checking cookies, or url parameters).
      // See https://github.com/websockets/ws#client-authentication
      this.wss.handleUpgrade(request, socket, head, /** @param {any} ws */ ws => {
        this.wss.emit('connection', ws, request)
      })
    })
  }

  /**
   * @returns {Promise<void>}
   */
  async listen () {
    await new Promise(resolve => {
      this.server.listen(this.port, this.host, () => {
        resolve(undefined)
      })
    })
  }

  /**
   * @returns {Promise<void>}
   */
  async close () {
    await Promise.all([
      new Promise(resolve => this.wss.close(resolve)),
      new Promise(resolve => this.server.close(resolve))
    ])
  }
}

/**
 * @param {{
 * host?: string,
 * port?: number,
 * namespace?: string,
 * gc?: boolean,
 * clusterSync?: import('./types.js').ClusterSyncRuntime | null
 * }} [options]
 */
const createWebsocketServer = (options = {}) => {
  return new WebsocketServerRuntime(options)
}

/**
 * @param {{
 * host?: string,
 * port?: number,
 * namespace?: string,
 * gc?: boolean,
 * clusterSync?: import('./types.js').ClusterSyncRuntime | null
 * }} [options]
 */
const startWebsocketServer = async (options = {}) => {
  const runtime = createWebsocketServer(options)
  await runtime.listen()
  return runtime
}

const runCli = async () => {
  const host = process.env.HOST || 'localhost'
  const port = number.parseInt(process.env.PORT || '1234')
  createClusterSyncFromEnv({ host, port, env: process.env })
  const runtime = await startWebsocketServer({
    host,
    port
  })
  console.log(`running at '${runtime.host}' on port ${runtime.port}`)
}

const isDirectRun = typeof process.argv[1] === 'string' && /(?:^|[/\\])server\.js$/.test(process.argv[1])
if (isDirectRun) {
  runCli().catch(err => {
    console.error('server startup failed', err)
    process.exitCode = 1
  })
}

export {
  WebsocketServerRuntime,
  createWebsocketServer,
  startWebsocketServer,
  createClusterSyncFromEnv
}
