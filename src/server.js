#!/usr/bin/env node

import WebSocket from 'ws'
import http from 'http'
import * as number from 'lib0/number'
import { setupWSConnection } from './utils-connection.js'
import { setClusterSync } from './utils-docs.js'
import { setupYdocCluster } from './cluster.js'

/**
 * @typedef {import('./types.js').WebsocketServerOptions} WebsocketServerOptions
 */

/**
 * Parses comma-separated NATS server URLs from an env string.
 */
const parseNatsServers = rawValue => rawValue
  .split(',')
  .map(server => server.trim())
  .filter(server => server.length > 0)

/**
 * Creates and installs cluster sync based on environment variables.
 */
const createClusterSyncFromEnv = ({ host, port, env = process.env }) => {
  const natsServers = parseNatsServers(env.NATS_SERVERS || '')
  if (natsServers.length === 0) {
    return null
  }
  return setupYdocCluster({
    nodeId: env.NATS_NODE_ID || `${host}:${port}:${process.pid}`,
    nats: {
      connectOptions: {
        servers: natsServers
      }
    },
    resyncIntervalMs: number.parseInt(env.NATS_RESYNC_INTERVAL || '30000')
  })
}

class WebsocketServerRuntime {
  /**
   * Creates a websocket server runtime with optional cluster sync integration.
   *
   * @param {WebsocketServerOptions} [options]
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
   * Starts listening on configured host and port.
   *
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
   * Closes websocket and HTTP servers.
   *
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
 * Creates a websocket runtime instance without starting it.
 *
 * @param {WebsocketServerOptions} [options]
 */
const createWebsocketServer = (options = {}) => {
  return new WebsocketServerRuntime(options)
}

/**
 * Creates and starts a websocket runtime instance.
 *
 * @param {WebsocketServerOptions} [options]
 */
const startWebsocketServer = async (options = {}) => {
  const runtime = createWebsocketServer(options)
  await runtime.listen()
  return runtime
}

/**
 * CLI entry point that starts the standalone websocket server process.
 */
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
