/**
 * @typedef {import('./types.js').SubjectTemplate} SubjectTemplate
 * @typedef {import('./types.js').ParsedBroadcastTopic} ParsedBroadcastTopic
 * @typedef {import('./types.js').CreateSubjectFormatterOptions} CreateSubjectFormatterOptions
 */

/**
 * Extracts placeholder token names from a subject template string.
 */
const extractTemplateTokens = template => {
  const matches = template.match(/\{[a-zA-Z0-9_]+\}/g) || []
  return matches.map(token => token.slice(1, -1))
}

/**
 * Ensures a subject template contains required tokens and no unknown tokens.
 */
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
 * Validates and normalizes a subject template configuration.
 *
 * @param {SubjectTemplate} subjectTemplate
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
    allowed: new Set(['topic', 'channel', 'event']),
    required: ['topic', 'channel', 'event'],
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
 * Renders a template string with the given token values.
 *
 * @param {string} template
 * @param {Record<string, string>} values
 */
const renderTemplate = (template, values) => template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, token) => {
  return values[token] || ''
})

/**
 * Parses a broadcast topic into topic/channel/event segments.
 *
 * @param {string} topic
 * @returns {ParsedBroadcastTopic | null}
 */
const parseBroadcastTopic = topic => {
  const firstDot = topic.indexOf('.')
  const lastDot = topic.lastIndexOf('.')
  if (firstDot <= 0 || lastDot <= firstDot + 1 || lastDot >= topic.length - 1) {
    return null
  }
  const topicName = topic.slice(0, firstDot)
  const channel = topic.slice(firstDot + 1, lastDot)
  const event = topic.slice(lastDot + 1)
  if (topicName.length === 0 || channel.length === 0 || event.length === 0) {
    return null
  }
  return { topic: topicName, channel, event }
}

/**
 * Creates helpers for generating broadcast and unicast subjects.
 *
 * @param {CreateSubjectFormatterOptions} options
 */
const createSubjectFormatter = ({ subjectTemplate }) => {
  const template = subjectTemplate === undefined
    ? null
    : validateSubjectTemplate(subjectTemplate)

  return {
    /**
     * Converts a logical topic name to a broadcast subject.
     *
     * @param {string} topic
     */
    broadcastSubject (topic) {
      if (template === null) {
        const parsed = parseBroadcastTopic(topic)
        if (parsed === null) {
          return `broadcast.${topic}`
        }
        return `broadcast.${parsed.topic}.${parsed.channel}.${parsed.event}`
      }
      const parsed = parseBroadcastTopic(topic)
      if (parsed === null) {
        throw new Error(`subjectTemplate.broadcast expects {topic}.{channel}.{event}, received: ${topic}`)
      }
      return renderTemplate(template.broadcast, {
        topic: parsed.topic,
        channel: parsed.channel,
        event: parsed.event
      })
    },

    /**
     * Converts node and method values to a unicast subject.
     *
     * @param {string} nodeId
     * @param {string} method
     */
    unicastSubject (nodeId, method) {
      if (template === null) {
        const normalizedMethod = method.startsWith('doc.')
          ? method.slice(4)
          : method
        return `unicast.doc.${nodeId}.${normalizedMethod}`
      }
      return renderTemplate(template.unicast, {
        nodeId,
        method
      })
    }
  }
}

export { createSubjectFormatter, parseBroadcastTopic, validateSubjectTemplate }
