import Ajv from 'ajv';

export const eventTypes = [
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'decision.started',
  'decision.resolved',
  'decision.failed',
  'action.selected',
  'action.started',
  'action.completed',
  'action.failed',
  'action.cancelled',
  'verification.completed',
  'progress.updated',
  'heartbeat',
  'telemetry.dropped',
] as const;
export type EventType = (typeof eventTypes)[number];
export interface Payload {
  name?: string;
  simulated?: boolean;
  phase?: string;
  summary?: string;
  question?: string;
  kind?: 'choice' | 'score' | 'noul';
  candidates?: Record<string, string | null>;
  choice?: string;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
  model?: string;
  latency_ms?: number;
  legend?: Record<string, string>;
  explanation?: string;
  explanation_source?: string;
  action?: string;
  source?: 'model' | 'rule' | 'application';
  rule?: string;
  rule_source?: string;
  reason?: string;
  result?: 'passed' | 'failed' | 'unknown';
  checks?: {name: string; observed: string; result: 'passed' | 'failed' | 'unknown'; evidence?: string}[];
  completed?: number;
  total?: number;
  count?: number;
  retry?: number;
  usage?: Record<string, number>;
  diagnostic?: unknown;
}
export interface MonitorEvent {
  schema_version: 1;
  event_id: string;
  run_id: string;
  producer_id: string;
  sequence: number;
  occurred_at: string;
  type: EventType;
  payload: Payload;
  decision_id?: string;
  request_id?: string;
  question_id?: string;
  action_id?: string;
  attempt_id?: string;
}
export interface StoredEvent extends MonitorEvent {
  received_at: string;
  cursor: number;
}
const str = {type: 'string', maxLength: 4096};
const id = {type: 'string', minLength: 1, maxLength: 160, pattern: '^[a-zA-Z0-9_.:/-]+$'};
const num = {type: 'number', minimum: 0};
const probability = {type: 'number', minimum: 0, maximum: 1};
const counter = {type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER};
const dictionary = (value: object) => ({
  type: 'object',
  maxProperties: 255,
  additionalProperties: value,
  propertyNames: {maxLength: 160, not: {enum: ['__proto__', 'constructor', 'prototype']}},
});
export const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'JEV Monitor event v1',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'event_id', 'run_id', 'producer_id', 'sequence', 'occurred_at', 'type', 'payload'],
  properties: {
    schema_version: {const: 1},
    event_id: id,
    run_id: id,
    producer_id: id,
    sequence: counter,
    occurred_at: {type: 'string', format: 'date-time'},
    type: {enum: eventTypes},
    decision_id: id,
    request_id: id,
    question_id: id,
    action_id: id,
    attempt_id: id,
    payload: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: str,
        simulated: {type: 'boolean'},
        phase: str,
        summary: str,
        question: str,
        kind: {enum: ['choice', 'score', 'noul']},
        candidates: dictionary({anyOf: [str, {type: 'null'}]}),
        choice: str,
        score: num,
        noul: probability,
        probabilities: dictionary(probability),
        confidence: probability,
        model: str,
        latency_ms: num,
        legend: dictionary(str),
        explanation: str,
        explanation_source: str,
        action: str,
        source: {enum: ['model', 'rule', 'application']},
        rule: str,
        rule_source: str,
        reason: str,
        result: {enum: ['passed', 'failed', 'unknown']},
        checks: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'observed', 'result'],
            properties: {name: str, observed: str, result: {enum: ['passed', 'failed', 'unknown']}, evidence: str},
          },
        },
        completed: counter,
        total: counter,
        count: counter,
        retry: counter,
        usage: dictionary(num),
        diagnostic: {},
      },
    },
  },
  allOf: [
    {
      if: {properties: {type: {enum: ['decision.started', 'decision.resolved', 'decision.failed']}}},
      then: {required: ['decision_id', 'request_id', 'question_id']},
    },
    {
      if: {
        properties: {
          type: {
            enum: [
              'action.selected',
              'action.started',
              'action.completed',
              'action.failed',
              'action.cancelled',
              'verification.completed',
            ],
          },
        },
      },
      then: {required: ['action_id', 'attempt_id']},
    },
    {
      if: {properties: {type: {const: 'decision.started'}}},
      then: {properties: {payload: {required: ['kind', 'question']}}},
    },
    {if: {properties: {type: {const: 'decision.resolved'}}}, then: {properties: {payload: {required: ['kind']}}}},
    {
      if: {properties: {type: {const: 'action.selected'}}},
      then: {properties: {payload: {required: ['action', 'source']}}},
    },
    {
      if: {properties: {type: {const: 'verification.completed'}}},
      then: {properties: {payload: {required: ['result', 'checks']}}},
    },
    {if: {properties: {type: {const: 'telemetry.dropped'}}}, then: {properties: {payload: {required: ['count']}}}},
  ],
};
const ajv = new Ajv({allErrors: true, strict: false});
ajv.addFormat(
  'date-time',
  (v: string) => /^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v)),
);
const check = ajv.compile(schema);
export function validateEvent(value: unknown): asserts value is MonitorEvent {
  if (!check(value)) throw new Error(ajv.errorsText(check.errors));
  const e = value as unknown as MonitorEvent,
    p = e.payload;
  if (
    e.type === 'decision.resolved' &&
    ((p.kind === 'choice' && p.choice === undefined) ||
      (p.kind === 'score' && p.score === undefined) ||
      (p.kind === 'noul' && p.noul === undefined))
  )
    throw new Error('Missing answer for primitive');
  if (p.kind === 'noul' && (p.confidence !== undefined || p.probabilities !== undefined))
    throw new Error('Noul has no confidence or option distribution');
  if (p.probabilities && Math.abs(Object.values(p.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02)
    throw new Error('Distribution must sum to one');
  if (p.total !== undefined && p.completed !== undefined && p.completed > p.total)
    throw new Error('Progress exceeds total');
  if (p.rule && !p.rule_source) throw new Error('Rule source required');
  if (p.explanation && !p.explanation_source) throw new Error('Explanation source required');
}
