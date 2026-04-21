const TOPIC_PARTS = new Set(['update', 'awareness'])

const extractTemplateTokens = template => {
  const matches = template.match(/\{[a-zA-Z0-9_]+\}/g) || []
  return matches.map(token => token.slice(1, -1))
}

const validateTemplateTokens = ({ template, allowed, required, templateName }) => {
  const tokens = extractTemplateTokens(template)
  const unknown = tokens.filter(token => !allowed.has(token))
  if (unknown.length > 0) {
    throw new Error(`Invalid subjectTemplate.${templateName}: unknown tokens ${unknown.join(', ')}`)
  }
  required.forEach(token => {
    if (!tokens.includes(token)) {
      throw new Error(`Invalid subjectTemplate.${templateName}: missing required token {${token}}`)
    }
  })
}

/**
 * @param {{ broadcast: string, unicast: string }} subjectTemplate
 */
const validateSubjectTemplate = subjectTemplate => {
  if (subjectTemplate == null || typeof subjectTemplate !== 'object') {
    throw new Error('subjectTemplate must be an object with { broadcast, unicast }')
  }
  const broadcastTemplate = subjectTemplate.broadcast
  const unicastTemplate = subjectTemplate.unicast

  if (typeof broadcastTemplate !== 'string' || broadcastTemplate.length === 0) {
    throw new Error('subjectTemplate.broadcast must be a non-empty string')
  }
  if (typeof unicastTemplate !== 'string' || unicastTemplate.length === 0) {
    throw new Error('subjectTemplate.unicast must be a non-empty string')
  }

  validateTemplateTokens({
    template: broadcastTemplate,
    allowed: new Set(['topic', 'doc', 'event']),
    required: ['topic', 'doc', 'event'],
    templateName: 'broadcast'
  })
  validateTemplateTokens({
    template: unicastTemplate,
    allowed: new Set(['nodeId', 'method']),
    required: ['nodeId', 'method'],
    templateName: 'unicast'
  })

  return {
    broadcast: broadcastTemplate,
    unicast: unicastTemplate
  }
}

/**
 * @param {string} template
 * @param {Record<string, string>} values
 */
const renderTemplate = (template, values) => template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, token) => {
  return values[token] || ''
})

/**
 * @param {string} topic
 * @returns {{ topic: string, doc: string, event: string } | null}
 */
const parseDocTopic = topic => {
  if (!topic.startsWith('doc.')) {
    return null
  }
  const lastDot = topic.lastIndexOf('.')
  if (lastDot <= 4) {
    return null
  }
  const event = topic.slice(lastDot + 1)
  if (!TOPIC_PARTS.has(event)) {
    return null
  }
  const docKey = topic.slice(4, lastDot)
  const keySep = docKey.indexOf(':')
  if (keySep < 0) {
    return null
  }
  const topicName = docKey.slice(0, keySep)
  const docName = docKey.slice(keySep + 1)
  if (topicName.length === 0 || docName.length === 0) {
    return null
  }
  return { topic: topicName, doc: docName, event }
}

/**
 * @param {{ subjectTemplate?: { broadcast: string, unicast: string } }} options
 */
const createSubjectFormatter = ({ subjectTemplate }) => {
  const template = subjectTemplate === undefined
    ? null
    : validateSubjectTemplate(subjectTemplate)

  return {
    /**
     * @param {string} topic
     */
    broadcastSubject (topic) {
      if (template === null) {
        const parsed = parseDocTopic(topic)
        if (parsed === null) {
          return `broadcast.${topic}`
        }
        return `broadcast.${parsed.topic}.${parsed.doc}.${parsed.event}`
      }
      const parsed = parseDocTopic(topic)
      if (parsed === null) {
        throw new Error(`subjectTemplate.broadcast only supports doc topics, received: ${topic}`)
      }
      return renderTemplate(template.broadcast, {
        topic: parsed.topic,
        doc: parsed.doc,
        event: parsed.event
      })
    },

    /**
     * @param {string} nodeId
     * @param {string} method
     */
    unicastSubject (nodeId, method) {
      if (template === null) {
        return `unicast.${nodeId}.${method}`
      }
      return renderTemplate(template.unicast, {
        nodeId,
        method
      })
    }
  }
}

export { createSubjectFormatter, parseDocTopic, validateSubjectTemplate }
