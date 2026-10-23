// Antworten aus Transaktionen: Innerhalb von `withMandant` nie `reply.send()` zurückgeben (FastifyReply ist
// „thenable“; Kysely würde darauf warten und bei 204 ohne Körper zurückrollen). Stattdessen Status und
// Körper zurückgeben und nach dem Commit senden.
import type { FastifyReply } from 'fastify';

export interface Antwort {
  code: number;
  body?: unknown;
}

export const antwort = (code: number, body?: unknown): Antwort => ({ code, body });

export function sende(reply: FastifyReply, a: Antwort): FastifyReply {
  return a.body === undefined ? reply.code(a.code).send() : reply.code(a.code).send(a.body);
}
