import * as awarenessProtocol from '@y/protocols/awareness'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'

const DEFAULT_SNAPSHOT_TTL_MS = 120000

const decodeAwarenessEntries = awarenessUpdate => {
  const decoder = decoding.createDecoder(awarenessUpdate)
  const len = decoding.readVarUint(decoder)
  const entries = []
  for (let i = 0; i < len; i++) {
    const clientId = decoding.readVarUint(decoder)
    const clock = decoding.readVarUint(decoder)
    const state = JSON.parse(decoding.readVarString(decoder))
    entries.push({ clientId, clock, state })
  }
  return entries
}

const encodeAwarenessEntries = entries => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, entries.length)
  entries.forEach(({ clientId, clock, state }) => {
    encoding.writeVarUint(encoder, clientId)
    encoding.writeVarUint(encoder, clock)
    encoding.writeVarString(encoder, JSON.stringify(state))
  })
  return encoding.toUint8Array(encoder)
}

const getLocallyControlledClients = (doc, awareness) => {
  const maybeDoc = /** @type {{ conns?: Map<any, Set<number>> } | null} */ (doc)
  if (maybeDoc === null || typeof maybeDoc !== 'object' || !(maybeDoc.conns instanceof Map)) {
    return null
  }
  const states = awareness.getStates()
  const controlled = new Set()
  maybeDoc.conns.forEach(clientSet => {
    if (!(clientSet instanceof Set)) {
      return
    }
    clientSet.forEach(clientId => {
      if (states.has(clientId)) {
        controlled.add(clientId)
      }
    })
  })
  return controlled
}

class AwarenessClusterState {
  constructor ({ nodeId, snapshotTtlMs = DEFAULT_SNAPSHOT_TTL_MS }) {
    this.nodeId = nodeId
    this.snapshotTtlMs = snapshotTtlMs
    /** @type {Map<string, Map<string, Map<number, { clock: number, state: any, updatedAt: number, epoch: number }>>>} */
    this.awarenessSnapshots = new Map()
    /** @type {Map<string, number>} */
    this.nodeEpochs = new Map([[this.nodeId, 1]])
    this.nextEpoch = 2
  }

  markAliveNodes (nodeIds) {
    nodeIds.forEach(nodeId => {
      if (!this.nodeEpochs.has(nodeId)) {
        this.nodeEpochs.set(nodeId, this.nextEpoch++)
      }
    })
  }

  dropDocSnapshots (docKey) {
    this.awarenessSnapshots.delete(docKey)
  }

  dropNodeSnapshots (nodeId) {
    this.awarenessSnapshots.forEach(byNode => {
      byNode.delete(nodeId)
    })
    this.nodeEpochs.delete(nodeId)
  }

  updateOwnershipFromChanges (state, ownerNodeId, changedClients) {
    let ownerSet = state.ownedAwarenessClientsByNode.get(ownerNodeId)
    if (ownerSet === undefined) {
      ownerSet = new Set()
      state.ownedAwarenessClientsByNode.set(ownerNodeId, ownerSet)
    }

    changedClients.forEach(clientId => {
      const current = state.awareness.getStates().get(clientId)
      if (current === undefined) {
        state.ownedAwarenessClientsByNode.forEach(clientSet => {
          clientSet.delete(clientId)
        })
        return
      }

      state.ownedAwarenessClientsByNode.forEach((clientSet, nodeId) => {
        if (nodeId !== ownerNodeId) {
          clientSet.delete(clientId)
        }
      })
      ownerSet.add(clientId)
    })

    if (ownerSet.size === 0) {
      state.ownedAwarenessClientsByNode.delete(ownerNodeId)
    }
  }

  refreshLocalOwnership (state) {
    const locallyControlled = getLocallyControlledClients(state.doc, state.awareness)
    if (locallyControlled === null) {
      return false
    }
    state.ownedAwarenessClientsByNode.set(this.nodeId, locallyControlled)
    state.ownedAwarenessClientsByNode.forEach((clientSet, ownerNodeId) => {
      if (ownerNodeId === this.nodeId) {
        return
      }
      locallyControlled.forEach(clientId => {
        clientSet.delete(clientId)
      })
    })
    return true
  }

  upsertSnapshot (docKey, ownerNodeId, awarenessUpdate) {
    const now = Date.now()
    const epoch = this.nodeEpochs.get(ownerNodeId) || 1
    let byNode = this.awarenessSnapshots.get(docKey)
    if (byNode === undefined) {
      byNode = new Map()
      this.awarenessSnapshots.set(docKey, byNode)
    }
    let byClient = byNode.get(ownerNodeId)
    if (byClient === undefined) {
      byClient = new Map()
      byNode.set(ownerNodeId, byClient)
    }
    decodeAwarenessEntries(awarenessUpdate).forEach(({ clientId, clock, state }) => {
      if (state === null) {
        byClient.delete(clientId)
      } else {
        byClient.set(clientId, { clock, state, updatedAt: now, epoch })
      }
    })
    if (byClient.size === 0) {
      byNode.delete(ownerNodeId)
    }
    if (byNode.size === 0) {
      this.awarenessSnapshots.delete(docKey)
    }
    this.prune(now)
  }

  upsertLocalSnapshotFromAwareness (state, docKey) {
    const localOwned = state.ownedAwarenessClientsByNode.get(this.nodeId)
    if (localOwned === undefined || localOwned.size === 0) {
      return
    }
    const entries = []
    localOwned.forEach(clientId => {
      const localState = state.awareness.getStates().get(clientId)
      const localMeta = state.awareness.meta.get(clientId)
      if (localState === undefined || localMeta === undefined) {
        return
      }
      entries.push({ clientId, clock: localMeta.clock, state: localState })
    })
    if (entries.length > 0) {
      this.upsertSnapshot(docKey, this.nodeId, encodeAwarenessEntries(entries))
    }
  }

  hydrateAwarenessFromSnapshots (state, docKey, remoteOrigin) {
    const byNode = this.awarenessSnapshots.get(docKey)
    if (byNode === undefined) {
      return
    }
    const payload = []
    byNode.forEach((byClient, ownerNodeId) => {
      if (ownerNodeId === this.nodeId) {
        return
      }
      byClient.forEach((entry, clientId) => {
        payload.push({ clientId, clock: entry.clock, state: entry.state })
      })
    })
    if (payload.length === 0) {
      return
    }
    awarenessProtocol.applyAwarenessUpdate(state.awareness, encodeAwarenessEntries(payload), remoteOrigin)
  }

  getSnapshotClientIds (docKey, ownerNodeId) {
    const byNode = this.awarenessSnapshots.get(docKey)
    if (byNode === undefined) {
      return []
    }
    const byClient = byNode.get(ownerNodeId)
    return byClient === undefined ? [] : Array.from(byClient.keys())
  }

  getSnapshotEntries (docKey, ownerNodeId) {
    const byNode = this.awarenessSnapshots.get(docKey)
    if (byNode === undefined) {
      return []
    }
    const byClient = byNode.get(ownerNodeId)
    if (byClient === undefined) {
      return []
    }
    return Array.from(byClient.entries(), ([clientId, entry]) => ({
      clientId,
      clock: entry.clock,
      state: entry.state
    }))
  }

  prune (now = Date.now()) {
    this.awarenessSnapshots.forEach((byNode, docKey) => {
      byNode.forEach((byClient, ownerNodeId) => {
        byClient.forEach((entry, clientId) => {
          if (now - entry.updatedAt > this.snapshotTtlMs) {
            byClient.delete(clientId)
          }
        })
        if (byClient.size === 0) {
          byNode.delete(ownerNodeId)
        }
      })
      if (byNode.size === 0) {
        this.awarenessSnapshots.delete(docKey)
      }
    })
  }
}

export { AwarenessClusterState, encodeAwarenessEntries }
