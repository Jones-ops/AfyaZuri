import { describe, expect, it } from 'vitest';
import { completeTicketBody, opdRouteBody } from '@afyazuri/shared';
import { canTransition, ticketLabel } from '../../src/modules/opd/service.js';

describe('queue ticket transitions', () => {
  it.each([
    ['call', 'waiting', true],
    ['call', 'called', true], // re-announce
    ['call', 'in_service', false],
    ['start', 'waiting', true],
    ['start', 'done', false],
    ['complete', 'in_service', true],
    ['complete', 'waiting', false],
    ['no_show', 'called', true],
    ['no_show', 'in_service', false],
    ['requeue', 'called', true],
    ['requeue', 'no_show', false],
  ])('%s from %s → %s', (action, status, ok) => expect(canTransition(action, status)).toBe(ok));
});

describe('ticket labels', () => {
  it('pads numbers', () => {
    expect(ticketLabel('T', 4)).toBe('T-004');
    expect(ticketLabel('A', 1234)).toBe('A-1234');
  });
});

describe('route and completion schemas', () => {
  it('requires routes to run from registration to exit', () => {
    expect(opdRouteBody.safeParse({ payerType: null, steps: ['registration', 'triage', 'exit'] }).success).toBe(true);
    expect(opdRouteBody.safeParse({ payerType: null, steps: ['triage', 'exit'] }).success).toBe(false);
    expect(opdRouteBody.safeParse({ payerType: null, steps: ['registration', 'triage'] }).success).toBe(false);
  });

  it('accepts the three ways to finish a ticket', () => {
    expect(completeTicketBody.safeParse({ next: { kind: 'route' } }).success).toBe(true);
    expect(completeTicketBody.safeParse({ next: { kind: 'exit' } }).success).toBe(true);
    expect(completeTicketBody.safeParse({ next: { kind: 'service_point' } }).success).toBe(false);
  });
});
