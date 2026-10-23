// SCIM-Ressourcen User und Group je Mandant (in einer Transaktion aus `withMandant`).
// User = Konto mit SCIM-Verknüpfung (`scim_konto`) oder mit Rolle im Mandanten; `id` = `benutzer.id`.
// Gespeichert werden nur userName (= Anmeldename, klein), externalId und active; Namen, Telefonnummern u. ä.
// nimmt seatmeter an und verwirft sie (Datensparsamkeit). Group = `mandant_scim_gruppe` mit Mitgliedern.
import { sql } from 'kysely';
import type { Trx } from '../konten/konten.js';
import { GROUP_SCHEMA, USER_SCHEMA } from './basis.js';

export interface KontoZeile {
  id: string;
  benutzername: string;
  deaktiviert: Date | null;
  erstellt: Date;
  external_id: string | null;
  scim_aktiv: boolean | null;
  geaendert: Date | null;
}

/** Sichtbare Konten des Mandanten (optional nur eines). */
export async function kontenLaden(trx: Trx, nurId?: string): Promise<KontoZeile[]> {
  const r = await sql<KontoZeile>`
    SELECT b.id, b.benutzername, b.deaktiviert, b.erstellt,
           s.external_id, s.aktiv AS scim_aktiv, s.geaendert
    FROM benutzer b
    LEFT JOIN scim_konto s ON s.benutzer_id = b.id
    WHERE (s.benutzer_id IS NOT NULL OR EXISTS (SELECT 1 FROM rolle r WHERE r.benutzer_id = b.id))
      ${nurId ? sql`AND b.id = ${nurId}::uuid` : sql``}
    ORDER BY b.erstellt, b.id`.execute(trx);
  return r.rows;
}

export interface GruppeZeile {
  id: string;
  display_name: string;
  external_id: string | null;
  erstellt: Date;
  geaendert: Date;
}

export async function gruppenLaden(trx: Trx, nurId?: string): Promise<GruppeZeile[]> {
  let q = trx
    .selectFrom('mandant_scim_gruppe')
    .select(['id', 'display_name', 'external_id', 'erstellt', 'geaendert'])
    .orderBy('erstellt')
    .orderBy('id');
  if (nurId) q = q.where('id', '=', nurId);
  return q.execute();
}

export async function mitgliedschaften(trx: Trx) {
  return trx
    .selectFrom('mandant_scim_mitglied as m')
    .innerJoin('benutzer as b', 'b.id', 'm.benutzer_id')
    .select(['m.gruppe_id', 'm.benutzer_id', 'b.benutzername'])
    .execute();
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : undefined);

export function userRessource(
  k: KontoZeile,
  basis: string,
  gruppen: { id: string; display_name: string }[],
) {
  return {
    schemas: [USER_SCHEMA],
    id: k.id,
    ...(k.external_id ? { externalId: k.external_id } : {}),
    userName: k.benutzername,
    active: !k.deaktiviert && k.scim_aktiv !== false,
    emails: k.benutzername.includes('@')
      ? [{ value: k.benutzername, type: 'work', primary: true }]
      : [],
    groups: gruppen.map((g) => ({
      value: g.id,
      display: g.display_name,
      $ref: `${basis}/Groups/${g.id}`,
    })),
    meta: {
      resourceType: 'User',
      created: iso(k.erstellt),
      lastModified: iso(k.geaendert ?? k.erstellt),
      location: `${basis}/Users/${k.id}`,
    },
  };
}

export function gruppeRessource(
  g: GruppeZeile,
  basis: string,
  mitglieder: { benutzer_id: string; benutzername: string }[] | null,
) {
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    ...(g.external_id ? { externalId: g.external_id } : {}),
    displayName: g.display_name,
    ...(mitglieder
      ? {
          members: mitglieder.map((m) => ({
            value: m.benutzer_id,
            display: m.benutzername,
            $ref: `${basis}/Users/${m.benutzer_id}`,
          })),
        }
      : {}),
    meta: {
      resourceType: 'Group',
      created: iso(g.erstellt),
      lastModified: iso(g.geaendert),
      location: `${basis}/Groups/${g.id}`,
    },
  };
}

/** Feste Beschreibungen (ServiceProviderConfig, ResourceTypes, Schemas). */
export function serviceProviderConfig(basis: string) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://www.rfc-editor.org/rfc/rfc7644',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer-Token',
        description: 'SCIM-Token des Mandanten (seatmeter: Einrichtung → SSO und Konten)',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${basis}/ServiceProviderConfig` },
  };
}

export function resourceTypes(basis: string) {
  return [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      schema: USER_SCHEMA,
      meta: { resourceType: 'ResourceType', location: `${basis}/ResourceTypes/User` },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      schema: GROUP_SCHEMA,
      meta: { resourceType: 'ResourceType', location: `${basis}/ResourceTypes/Group` },
    },
  ];
}

const attr = (
  name: string,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name,
  type,
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

export function schemas(basis: string) {
  return [
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      id: USER_SCHEMA,
      name: 'User',
      description: 'Dashboard-Konto (seatmeter speichert nur userName, externalId und active)',
      attributes: [
        attr('userName', 'string', { required: true, uniqueness: 'server' }),
        attr('active', 'boolean'),
        attr('emails', 'complex', {
          multiValued: true,
          subAttributes: [
            attr('value', 'string'),
            attr('type', 'string'),
            attr('primary', 'boolean'),
          ],
        }),
        attr('groups', 'complex', { multiValued: true, mutability: 'readOnly' }),
      ],
      meta: { resourceType: 'Schema', location: `${basis}/Schemas/${USER_SCHEMA}` },
    },
    {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
      id: GROUP_SCHEMA,
      name: 'Group',
      description: 'Gruppe; Rollen über die Gruppen-Zuordnung des Mandanten',
      attributes: [
        attr('displayName', 'string', { required: true, uniqueness: 'server' }),
        attr('members', 'complex', {
          multiValued: true,
          subAttributes: [
            attr('value', 'string'),
            attr('display', 'string', { mutability: 'readOnly' }),
          ],
        }),
      ],
      meta: { resourceType: 'Schema', location: `${basis}/Schemas/${GROUP_SCHEMA}` },
    },
  ];
}
