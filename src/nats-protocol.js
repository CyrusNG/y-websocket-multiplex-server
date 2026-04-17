import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'

const MSG_UPDATE = 1
const MSG_AWARENESS = 2
const MSG_SYNC_REQUEST = 3
const MSG_SYNC_RESPONSE = 4

const getUpdateTopic = docKey => `doc.${docKey}.update`
const getAwarenessTopic = docKey => `doc.${docKey}.awareness`
const getSyncMethod = docKey => `doc.${docKey}.sync`

const writeNumberArray = (encoder, values) => {
  encoding.writeVarUint(encoder, values.length)
  for (let i = 0; i < values.length; i++) {
    encoding.writeVarUint(encoder, values[i])
  }
}

const readNumberArray = decoder => {
  const length = decoding.readVarUint(decoder)
  const values = []
  for (let i = 0; i < length; i++) {
    values.push(decoding.readVarUint(decoder))
  }
  return values
}

const encodeUpdateMessage = (senderNodeId, update) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_UPDATE)
  encoding.writeVarString(encoder, senderNodeId)
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

const encodeAwarenessMessage = (senderNodeId, awarenessUpdate, changedClients) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_AWARENESS)
  encoding.writeVarString(encoder, senderNodeId)
  encoding.writeVarUint8Array(encoder, awarenessUpdate)
  writeNumberArray(encoder, changedClients)
  return encoding.toUint8Array(encoder)
}

const encodeSyncRequest = (requesterNodeId, stateVector) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC_REQUEST)
  encoding.writeVarString(encoder, requesterNodeId)
  encoding.writeVarUint8Array(encoder, stateVector)
  return encoding.toUint8Array(encoder)
}

const encodeSyncResponse = diffUpdate => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MSG_SYNC_RESPONSE)
  encoding.writeVarUint8Array(encoder, diffUpdate)
  return encoding.toUint8Array(encoder)
}

const decodeMessage = payload => {
  const decoder = decoding.createDecoder(payload)
  const messageType = decoding.readVarUint(decoder)

  if (messageType === MSG_UPDATE) {
    return {
      messageType,
      senderNodeId: decoding.readVarString(decoder),
      update: decoding.readVarUint8Array(decoder)
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

  throw new Error(`Unsupported cluster message type: ${messageType}`)
}

const MESSAGE_TYPE = {
  UPDATE: MSG_UPDATE,
  AWARENESS: MSG_AWARENESS,
  SYNC_REQUEST: MSG_SYNC_REQUEST,
  SYNC_RESPONSE: MSG_SYNC_RESPONSE
}

export {
  getUpdateTopic,
  getAwarenessTopic,
  getSyncMethod,
  encodeUpdateMessage,
  encodeAwarenessMessage,
  encodeSyncRequest,
  encodeSyncResponse,
  decodeMessage,
  MESSAGE_TYPE
}
