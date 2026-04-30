/**
 * Shared typedefs for JS + JSDoc type-checking.
 * Grouped by domain to keep runtime files focused on logic.
 */

/**
 * @typedef {{
 * broadcast: string,
 * unicast: string
 * }} SubjectTemplate
 */
/**
 * @typedef {Object<string, string>} StringMap
 */
/**
 * @typedef {{
 * topic: string,
 * doc: string,
 * event: string
 * }} ParsedDocTopic
 */
/**
 * @typedef {{
 * connection?: any,
 * connectOptions?: import('nats').ConnectionOptions,
 * subjectTemplate?: SubjectTemplate,
 * requestTimeoutMs?: number,
 * maxRetries?: number,
 * closeNatsOnClose?: boolean
 * }} ClusterNatsOptions
 */
/**
 * @typedef {string | null | undefined} OptionalNodeId
 */
/**
 * @typedef {{
 * subjectTemplate?: SubjectTemplate
 * }} CreateSubjectFormatterOptions
 */

/**
 * Provider / Observable
 */
/**
 * @typedef {(...args: Array<any>) => void} Listener
 */
/**
 * @typedef {{
 * maxBackoffTime: number,
 * protocols?: string | Array<string>,
 * WebSocketPolyfill: typeof WebSocket
 * }} MultiplexSocketManagerOptions
 */
/**
 * @typedef {{
 * connect?: boolean,
 * params?: StringMap,
 * protocols?: string | Array<string>,
 * WebSocketPolyfill?: typeof WebSocket,
 * maxBackoffTime?: number
 * }} MultiplexProviderOptions
 */
/**
 * @typedef {import('@y/protocols/awareness').Awareness | null} MaybeAwareness
 */
/**
 * @typedef {'local'|'remote'|'all'} AwarenessRemovalScope
 */
/**
 * @typedef {Uint8Array | ArrayBuffer | Blob | string} SocketMessageData
 */
/**
 * @typedef {WebSocket | null} MaybeWebSocket
 */
/**
 * @typedef {{
 * awareness?: boolean | MaybeAwareness,
 * connect?: boolean,
 * disableBc?: boolean,
 * resyncInterval?: number
 * }} MultiplexAttachOptions
 */
/**
 * @typedef {{
 * room: string,
 * data: Record<string, { type: string, content: any }>
 * }} CallbackData
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
 * isClusterOrigin?: (origin: any) => boolean,
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
 * connectOptions?: import('nats').ConnectionOptions,
 * subjectTemplate?: SubjectTemplate,
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
 * @typedef {(payload: Uint8Array, meta: BusMessageMeta) => void | Promise<void>} BusSubscribeHandler
 */
/**
 * @typedef {(payload: Uint8Array, meta: BusMessageMeta) => Uint8Array | Promise<Uint8Array>} BusHandleHandler
 */
/**
 * @typedef {(msg: any) => void | Promise<void>} SubscriptionMessageHandler
 */
/**
 * @typedef {{
 * nc: any,
 * nodeId: string,
 * subjectTemplate?: SubjectTemplate,
 * requestTimeoutMs?: number,
 * maxRetries?: number,
 * closeNatsOnClose?: boolean
 * }} NatsConnectionBusOptions
 */

/**
 * Doc Sync Transport / Engine
 */
/**
 * @typedef {{
 * onUpdate: (senderNodeId: string, update: Uint8Array, updateId?: string) => void,
 * onAwareness: (senderNodeId: string, awarenessUpdate: Uint8Array, changedClients: Array<number>) => void,
 * onSyncRequest: (requesterNodeId: string, stateVector: Uint8Array) => Uint8Array
 * }} DocSubscribeHandlers
 */
/**
 * @typedef {{
 * subscribeDoc: (docKey: string, handlers: DocSubscribeHandlers) => Promise<() => void>,
 * publishUpdate: (docKey: string, senderNodeId: string, update: Uint8Array, origin?: any) => Promise<void>,
 * publishAwareness: (docKey: string, senderNodeId: string, awarenessUpdate: Uint8Array, changedClients: Array<number>, origin?: any) => Promise<void>,
 * requestSync: (docKey: string, targetNodeId: string, requesterNodeId: string, stateVector: Uint8Array) => Promise<Uint8Array>
 * }} DocSyncTransport
 */
/**
 * @typedef {{
 * bus: import('./nats-bus.js').NatsBus
 * }} NatsDocTransportOptions
 */
/**
 * @typedef {{
 * onPublishUpdate: (update: Uint8Array) => Promise<void> | void,
 * onPublishAwareness: (awarenessUpdate: Uint8Array, changedClients: Array<number>, origin: any) => Promise<void> | void
 * }} WsDocTransportOptions
 */
/**
 * @typedef {{
 * doc: import('yjs').Doc,
 * awareness: import('@y/protocols/awareness').Awareness,
 * docKey: string,
 * nodeId: string,
 * transport: DocSyncTransport,
 * remoteOrigin: any,
 * isClusterOrigin?: (origin: any) => boolean,
 * onRemoteAwareness: (senderNodeId: string, changedClients: Array<number>) => void
 * }} DocSyncEngineOptions
 */

/**
 * Cluster Adapter / Cluster Runtime
 */
/**
 * @typedef {{
 * destroy: () => Promise<void>,
 * docName: string,
 * namespace: string
 * }} ClusterBoundDocRef
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
 * bus?: any,
 * nats?: ClusterNatsOptions,
 * resyncIntervalMs?: number,
 * chooseSyncNode?: (docKey: string, aliveNodes: Array<string>, currentSyncNode: string | null) => string | null
 * }} CreateClusterSyncOptions
 */
/**
 * @typedef {{
 * host?: string,
 * port?: number,
 * namespace?: string,
 * gc?: boolean,
 * clusterSync?: ClusterSyncRuntime | null
 * }} WebsocketServerOptions
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
