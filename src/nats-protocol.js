import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'

const MSG_UPDATE = 1
const MSG_AWARENESS = 2
const MSG_SYNC_REQUEST = 3
const MSG_SYNC_RESPONSE = 4
const MSG_AWARENESS_SNAPSHOT = 5
const MSG_AWARENESS_SOLICIT = 6

/**
 * Returns topic name for update fanout of one doc.
 */
const getUpdateTopic = docKey => `doc.${docKey}.update`
/**
 * Returns topic name for awareness fanout of one doc.
 */
const getAwarenessTopic = docKey => `doc.${docKey}.awareness`
/**
 * Returns RPC method subject for on-demand doc sync.
 */
const getSyncMethod = docKey => `doc.${docKey}.anti-entropy`
/**
 * Returns topic name for cluster-global awareness snapshots.
 */
const getAwarenessSnapshotTopic = () => 'bus.awareness.anti-entropy'
/**
 * Returns topic name for cluster-global awareness snapshot solicitation.
 */
const getAwarenessSolicitTopic = () => 'bus.awareness.anti-entropy'

/**
 * Encodes an array of numbers using varint entries.
 */
const writeNumberArray = (encoder, values) => {
  encoding.writeVarUint(encoder, values.length)
  for (let i = 0; i < values.length; i++) {
    encoding.writeVarUint(encoder, values[i])
  }
}

/**
 * Decodes an array of numbers written by writeNumberArray.
 */
const readNumberArray = decoder => {
  const length = decoding.readVarUint(decoder)
  const values = []
  for (let i = 0; i < length; i++) {
    values.push(decoding.readVarUint(decoder))
  }
  return values
}

/**
 * Encodes a doc update transport payload.
 */
const encodeUpdateMessage = (senderNodeId, update, updateId) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_UPDATE)
  encoding.writeVarString(encoder, senderNodeId)
  encoding.writeVarUint8Array(encoder, update)
  encoding.writeVarString(encoder, typeof updateId === 'string' ? updateId : '')
  return encoding.toUint8Array(encoder)
}

/**
 * Encodes an awareness transport payload.
 */
const encodeAwarenessMessage = (senderNodeId, awarenessUpdate, changedClients) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_AWARENESS)
  encoding.writeVarString(encoder, senderNodeId)
  encoding.writeVarUint8Array(encoder, awarenessUpdate)
  writeNumberArray(encoder, changedClients)
  return encoding.toUint8Array(encoder)
}

/**
 * Encodes a sync request payload.
 */
const encodeSyncRequest = (requesterNodeId, stateVector) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC_REQUEST)
  encoding.writeVarString(encoder, requesterNodeId)
  encoding.writeVarUint8Array(encoder, stateVector)
  return encoding.toUint8Array(encoder)
}

/**
 * Encodes a sync response payload.
 */
const encodeSyncResponse = diffUpdate => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC_RESPONSE)
  encoding.writeVarUint8Array(encoder, diffUpdate)
  return encoding.toUint8Array(encoder)
}

/**
 * Encodes a cluster-global awareness snapshot payload.
 */
const encodeAwarenessSnapshotMessage = (docKey, senderNodeId, awarenessUpdate, changedClients) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_AWARENESS_SNAPSHOT)
  encoding.writeVarString(encoder, docKey)
  encoding.writeVarString(encoder, senderNodeId)
  encoding.writeVarUint8Array(encoder, awarenessUpdate)
  writeNumberArray(encoder, changedClients)
  return encoding.toUint8Array(encoder)
}

/**
 * Encodes a cluster-global awareness snapshot solicitation payload.
 */
const encodeAwarenessSolicitMessage = (docKey, requesterNodeId, roundId) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_AWARENESS_SOLICIT)
  encoding.writeVarString(encoder, docKey)
  encoding.writeVarString(encoder, requesterNodeId)
  encoding.writeVarString(encoder, roundId)
  return encoding.toUint8Array(encoder)
}

/**
 * Decodes a transport payload and returns typed message data.
 */
const decodeMessage = payload => {
  const decoder = decoding.createDecoder(payload)
  const messageType = decoding.readVarUint(decoder)

  if (messageType === MSG_UPDATE) {
    const senderNodeId = decoding.readVarString(decoder)
    const update = decoding.readVarUint8Array(decoder)
    // Keep backward compatibility with older payloads that do not include updateId.
    const updateId = decoding.hasContent(decoder) ? decoding.readVarString(decoder) : ''
    return {
      messageType,
      senderNodeId,
      update,
      updateId: updateId.length > 0 ? updateId : undefined
    }
  }

  if (messageType === MSG_AWARENESS) {
    return {
      messageType,
      senderNodeId: decoding.readVarString(decoder),
      awarenessUpdate: decoding.readVarUint8Array(decoder),
      changedClients: readNumberArray(decoder)
    }
  }

  if (messageType === MSG_SYNC_REQUEST) {
    return {
      messageType,
      requesterNodeId: decoding.readVarString(decoder),
      stateVector: decoding.readVarUint8Array(decoder)
    }
  }

  if (messageType === MSG_SYNC_RESPONSE) {
    return {
      messageType,
      diffUpdate: decoding.readVarUint8Array(decoder)
    }
  }

  if (messageType === MSG_AWARENESS_SNAPSHOT) {
    return {
      messageType,
      docKey: decoding.readVarString(decoder),
      senderNodeId: decoding.readVarString(decoder),
      awarenessUpdate: decoding.readVarUint8Array(decoder),
      changedClients: readNumberArray(decoder)
    }
  }

  if (messageType === MSG_AWARENESS_SOLICIT) {
    return {
      messageType,
      docKey: decoding.readVarString(decoder),
      requesterNodeId: decoding.readVarString(decoder),
      roundId: decoding.readVarString(decoder)
    }
  }

  throw new Error(`Unsupported cluster message type: ${messageType}`)
}

const MESSAGE_TYPE = {
  UPDATE: MSG_UPDATE,
  AWARENESS: MSG_AWARENESS,
  SYNC_REQUEST: MSG_SYNC_REQUEST,
  SYNC_RESPONSE: MSG_SYNC_RESPONSE,
  AWARENESS_SNAPSHOT: MSG_AWARENESS_SNAPSHOT,
  AWARENESS_SOLICIT: MSG_AWARENESS_SOLICIT
}

export {
  getUpdateTopic,
  getAwarenessTopic,
  getSyncMethod,
  getAwarenessSnapshotTopic,
  getAwarenessSolicitTopic,
  encodeUpdateMessage,
  encodeAwarenessMessage,
  encodeAwarenessSnapshotMessage,
  encodeAwarenessSolicitMessage,
  encodeSyncRequest,
  encodeSyncResponse,
  decodeMessage,
  MESSAGE_TYPE
}
