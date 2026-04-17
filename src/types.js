/**
 * Shared typedefs for JS + JSDoc type-checking.
 * Grouped by domain to keep runtime files focused on logic.
 */

/**
 * Provider / Observable
 */
/**
 * @typedef {(...args: Array<any>) => void} Listener
 */

/**
 * Sync Core
 */
/**
 * @typedef {{ added: Array<number>, updated: Array<number>, removed: Array<number> }} AwarenessChanges
 */
/**
 * @typedef {{
 * doc: import('yjs').Doc,
 * awareness: import('@y/protocols/awareness').Awareness,
 * remoteOrigin: any,
 * onLocalUpdate: (update: Uint8Array, origin: any) => (void | Promise<void>),
 * onLocalAwarenessUpdate: (changes: AwarenessChanges, origin: any) => (void | Promise<void>)
 * }} CreateYDocSyncCoreOptions
 */

/**
 * NATS Bus
 */
/**
 * @typedef {{
 * nodeId: string,
 * servers?: Array<string>,
 * connectOptions?: import('nats').ConnectionOptions,
 * prefix?: string,
 * requestTimeoutMs?: number,
 * maxRetries?: number
 * }} NatsBusOptions
 */
/**
 * @typedef {{
 * subject: string,
 * reply: string,
 * headers: any,
 * senderNodeId: string | null
 * }} BusMessageMeta
 */
/**
 * @typedef {{
 * timeoutMs?: number,
 * retries?: number
 * }} BusRequestOptions
 */

/**
 * Doc Sync Transport / Engine
 */
/**
 * @typedef {{
 * subscribeDoc: (docKey: string, handlers: {
 *   onUpdate: (senderNodeId: string, update: Uint8Array) => void,
 *   onAwareness: (senderNodeId: string, awarenessUpdate: Uint8Array, changedClients: Array<number>) => void,
 *   onSyncRequest: (requesterNodeId: string, stateVector: Uint8Array) => Uint8Array
 * }) => Promise<() => void>,
 * publishUpdate: (docKey: string, senderNodeId: string, update: Uint8Array, origin?: any) => Promise<void>,
 * publishAwareness: (docKey: string, senderNodeId: string, awarenessUpdate: Uint8Array, changedClients: Array<number>, origin?: any) => Promise<void>,
 * requestSync: (docKey: string, targetNodeId: string, requesterNodeId: string, stateVector: Uint8Array) => Promise<Uint8Array>
 * }} DocSyncTransport
 */
/**
 * @typedef {{
 * doc: import('yjs').Doc,
 * awareness: import('@y/protocols/awareness').Awareness,
 * docKey: string,
 * nodeId: string,
 * transport: DocSyncTransport,
 * remoteOrigin: any,
 * onRemoteAwareness: (senderNodeId: string, changedClients: Array<number>) => void
 * }} DocSyncEngineOptions
 */

/**
 * Cluster Adapter / Cluster Runtime
 */
/**
 * @typedef {{
 * bindState: (name: string, doc: import('./utils-docs.js').WSSharedDoc) => (Promise<any> | any),
 * unbindState: (name: string, doc: import('./utils-docs.js').WSSharedDoc) => (Promise<any> | any),
 * provider: any
 * }} PersistenceAdapter
 */
/**
 * @typedef {{
 * connect: () => (Promise<void> | void),
 * close?: () => (Promise<void> | void),
 * bindDoc: (namespace: string, docName: string, doc: import('./utils-docs.js').WSSharedDoc, awareness: import('@y/protocols/awareness').Awareness) => (Promise<any> | any),
 * unbindDoc?: (namespace: string, docName: string) => (Promise<void> | void),
 * resyncDoc?: (namespace: string, docName: string) => (Promise<boolean> | boolean),
 * setNodes?: (syncNode: string | null | undefined, nodeIds: Array<string>) => void,
 * removeNode?: (nodeId: string) => void,
 * resyncAllDocs?: () => (Promise<void> | void)
 * }} ClusterSyncRuntime
 */
/**
 * @typedef {{
 * nodeId: string,
 * servers?: Array<string>,
 * connectOptions?: import('nats').ConnectionOptions,
 * bus?: any,
 * nats?: any,
 * closeNatsOnClose?: boolean,
 * prefix?: string,
 * requestTimeoutMs?: number,
 * maxRetries?: number,
 * defaultNamespace?: string,
 * resyncIntervalMs?: number,
 * chooseSyncNode?: (docKey: string, aliveNodes: Array<string>, currentSyncNode: string | null) => string | null
 * }} CreateClusterSyncOptions
 */
/**
 * @typedef {{
 * connect: () => Promise<void>,
 * close: () => Promise<void>,
 * bindDoc: (namespace: string, docName: string, doc: import('yjs').Doc, awareness: import('@y/protocols/awareness').Awareness) => Promise<any>,
 * unbindDoc: (namespace: string, docName: string) => Promise<void>,
 * resyncDoc?: (namespace: string, docName: string) => Promise<boolean>,
 * setNodes?: (syncNode: string | null | undefined, nodeIds: Array<string>) => void,
 * removeNode?: (nodeId: string) => void,
 * resyncAllDocs?: () => Promise<void>
 * }} ClusterSyncAdapter
 */
/**
 * @typedef {{
 * bus: import('./nats-bus.js').NatsBus,
 * nodeId: string,
 * defaultNamespace?: string,
 * chooseSyncNode?: (docKey: string, aliveNodes: Array<string>, currentSyncNode: string | null) => string | null,
 * resyncIntervalMs?: number
 * }} YjsNatsClusterOptions
 */
/**
 * @typedef {{
 * namespace: string,
 * docName: string,
 * doc: import('yjs').Doc,
 * awareness: import('@y/protocols/awareness').Awareness,
 * engine: import('./doc-sync-engine.js').DocSyncEngine,
 * ownedAwarenessClientsByNode: Map<string, Set<number>>,
 * unsubs: Array<() => void>
 * }} BoundDocState
 */

export {}
