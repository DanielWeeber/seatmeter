// Gemeinsames für SCIM 2.0 (RFC 7643/7644): Schema-URNs, Fehlerformat, Listenantwort, Booleans aus Entra ID
// ("True"/"False"), Abbruch innerhalb von Transaktionen (rollt zurück, Antwort erst danach).
import type { FastifyReply } from 'fastify';

export const SCIM_TYP = 'application/scim+json; charset=utf-8';
export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

export type ScimTyp =
  | 'invalidFilter'
  | 'tooMany'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'noTarget'
  | 'invalidValue';

/** Fehler im SCIM-Format; innerhalb von `withMandant` geworfen, rollt er die Transaktion zurück. */
export class ScimAbbruch extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: ScimTyp,
  ) {
    super(detail);
  }
}

export function scimFehler(
  reply: FastifyReply,
  status: number,
  detail: string,
  scimType?: ScimTyp,
) {
  return reply
    .code(status)
    .type(SCIM_TYP)
    .send({
      schemas: [ERROR_SCHEMA],
      status: String(status),
      ...(scimType ? { scimType } : {}),
      detail,
    });
}

export function scimSenden(reply: FastifyReply, status: number, body: unknown) {
  return reply.code(status).type(SCIM_TYP).send(body);
}

/** Paging (1-basiert) und Listenantwort. */
export function liste(ressourcen: unknown[], startIndex: number, count: number) {
  const start = Math.max(1, startIndex);
  const seite = ressourcen.slice(start - 1, start - 1 + count);
  return {
    schemas: [LIST_SCHEMA],
    totalResults: ressourcen.length,
    startIndex: start,
    itemsPerPage: seite.length,
    Resources: seite,
  };
}

/** Boolean aus JSON oder als Zeichenkette (Entra ID sendet "True"/"False"). */
export function alsBoolean(wert: unknown): boolean {
  if (typeof wert === 'boolean') return wert;
  if (typeof wert === 'string') {
    const w = wert.trim().toLowerCase();
    if (w === 'true') return true;
    if (w === 'false') return false;
  }
  throw new ScimAbbruch(400, 'Boolean erwartet (true/false)', 'invalidValue');
}

/** Zeichenkette (1–200 Zeichen) oder Abbruch. */
export function alsText(wert: unknown, feld: string): string {
  if (typeof wert !== 'string' || !wert.trim() || wert.length > 200)
    throw new ScimAbbruch(400, `${feld}: Zeichenkette (1–200) erwartet`, 'invalidValue');
  return wert.trim();
}

export function alsObjekt(wert: unknown): Record<string, unknown> {
  if (!wert || typeof wert !== 'object' || Array.isArray(wert))
    throw new ScimAbbruch(400, 'Objekt erwartet', 'invalidSyntax');
  return wert as Record<string, unknown>;
}

/** Operationen eines PATCH-Körpers (`op` ohne Beachtung der Schreibweise). */
export function patchOperationen(
  body: unknown,
): { op: 'add' | 'replace' | 'remove'; path: string | null; value: unknown }[] {
  const ops = alsObjekt(body).Operations ?? alsObjekt(body).operations;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 1000)
    throw new ScimAbbruch(400, 'Operations fehlt', 'invalidSyntax');
  return ops.map((o) => {
    const x = alsObjekt(o);
    const op = String(x.op ?? '').toLowerCase();
    if (op !== 'add' && op !== 'replace' && op !== 'remove')
      throw new ScimAbbruch(400, `Unbekannte Operation: ${String(x.op)}`, 'invalidSyntax');
    const path = typeof x.path === 'string' && x.path.trim() ? x.path : null;
    return { op, path, value: x.value };
  });
}
