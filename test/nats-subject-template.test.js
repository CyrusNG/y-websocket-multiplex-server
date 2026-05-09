import test from 'node:test'
import assert from 'node:assert/strict'
import { createSubjectFormatter, parseBroadcastTopic, validateSubjectTemplate } from '../src/nats-subject.js'
import { NatsBus } from '../src/nats-bus.js'

test('uses default subject format when no template is provided', () => {
  const formatter = createSubjectFormatter({})
  assert.equal(formatter.broadcastSubject('doc.default-page-1.update'), 'broadcast.doc.default-page-1.update')
  assert.equal(formatter.unicastSubject('node-a', 'doc.default-page-1.anti-entropy'), 'unicast.doc.node-a.default-page-1.anti-entropy')
})

test('uses configured subject templates for broadcast and unicast', () => {
  const formatter = createSubjectFormatter({
    subjectTemplate: {
      broadcast: 'myapp.broadcast.{topic}.{channel}.{event}',
      unicast: 'myapp.unicast.{nodeId}.{method}'
    }
  })

  assert.equal(
    formatter.broadcastSubject('doc.default-page-1.update'),
    'myapp.broadcast.doc.default-page-1.update'
  )
  assert.equal(
    formatter.broadcastSubject('bus.awareness.anti-entropy'),
    'myapp.broadcast.bus.awareness.anti-entropy'
  )
  assert.equal(
    formatter.unicastSubject('node-a', 'doc.default-page-1.anti-entropy'),
    'myapp.unicast.node-a.doc.default-page-1.anti-entropy'
  )
})

test('throws when template misses required tokens', () => {
  assert.throws(() => {
    validateSubjectTemplate({
      broadcast: 'myapp.broadcast.{topic}.{channel}',
      unicast: 'myapp.unicast.{nodeId}.{method}'
    })
  }, /missing required token \{event\}/)

  assert.throws(() => {
    validateSubjectTemplate({
      broadcast: 'myapp.broadcast.{topic}.{channel}.{event}',
      unicast: 'myapp.unicast.{nodeId}'
    })
  }, /missing required token \{method\}/)
})

test('throws when template contains unknown tokens', () => {
  assert.throws(() => {
    validateSubjectTemplate({
      broadcast: 'myapp.broadcast.{topic}.{channel}.{event}.{extra}',
      unicast: 'myapp.unicast.{nodeId}.{method}'
    })
  }, /unknown tokens extra/)
})

test('parses broadcast topic parts for subject templating', () => {
  assert.deepEqual(parseBroadcastTopic('doc.default-page-1.update'), {
    topic: 'doc',
    channel: 'default-page-1',
    event: 'update'
  })
  assert.deepEqual(parseBroadcastTopic('bus.awareness.solicit'), {
    topic: 'bus',
    channel: 'awareness',
    event: 'solicit'
  })
  assert.equal(parseBroadcastTopic('doc.invalid'), null)
})

test('formats internal bus topics with broadcast template when configured', () => {
  const bus = new NatsBus({
    nodeId: 'node-a',
    connectOptions: { servers: ['nats://127.0.0.1:4222'] },
    subjectTemplate: {
      broadcast: 'myapp.broadcast.{topic}.{channel}.{event}',
      unicast: 'myapp.unicast.{nodeId}.{method}'
    }
  })
  assert.equal(bus.broadcastSubject('bus.awareness.anti-entropy'), 'myapp.broadcast.bus.awareness.anti-entropy')
  assert.equal(bus.broadcastSubject('bus.awareness.solicit'), 'myapp.broadcast.bus.awareness.solicit')
})
