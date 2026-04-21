import test from 'node:test'
import assert from 'node:assert/strict'
import { createSubjectFormatter, parseDocTopic, validateSubjectTemplate } from '../src/nats-subject.js'

test('uses default subject format when no template is provided', () => {
  const formatter = createSubjectFormatter({})
  assert.equal(formatter.broadcastSubject('doc.default:page-1.update'), 'broadcast.default.page-1.update')
  assert.equal(formatter.unicastSubject('node-a', 'doc.default:page-1.sync'), 'unicast.node-a.doc.default:page-1.sync')
})

test('uses configured subject templates for broadcast and unicast', () => {
  const formatter = createSubjectFormatter({
    subjectTemplate: {
      broadcast: 'myapp.broadcast.{topic}.{doc}.{event}',
      unicast: 'myapp.unicast.{nodeId}.{method}'
    }
  })

  assert.equal(
    formatter.broadcastSubject('doc.default:page-1.update'),
    'myapp.broadcast.default.page-1.update'
  )
  assert.equal(
    formatter.unicastSubject('node-a', 'doc.default:page-1.sync'),
    'myapp.unicast.node-a.doc.default:page-1.sync'
  )
})

test('throws when template misses required tokens', () => {
  assert.throws(() => {
    validateSubjectTemplate({
      broadcast: 'myapp.broadcast.{topic}.{doc}',
      unicast: 'myapp.unicast.{nodeId}.{method}'
    })
  }, /missing required token \{event\}/)

  assert.throws(() => {
    validateSubjectTemplate({
      broadcast: 'myapp.broadcast.{topic}.{doc}.{event}',
      unicast: 'myapp.unicast.{nodeId}'
    })
  }, /missing required token \{method\}/)
})

test('throws when template contains unknown tokens', () => {
  assert.throws(() => {
    validateSubjectTemplate({
      broadcast: 'myapp.broadcast.{topic}.{doc}.{event}.{extra}',
      unicast: 'myapp.unicast.{nodeId}.{method}'
    })
  }, /unknown tokens extra/)
})

test('parses doc topic parts for subject templating', () => {
  assert.deepEqual(parseDocTopic('doc.default:page-1.update'), {
    topic: 'default',
    doc: 'page-1',
    event: 'update'
  })
  assert.equal(parseDocTopic('doc.default:page-1.sync'), null)
})
