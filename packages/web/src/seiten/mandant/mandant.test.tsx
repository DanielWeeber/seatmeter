// Seite „Tokens und Orgs“ (/mandant, Kern): Tokens, Orgs und Rollen des aktiven Mandanten über
// /api/v1/mandant/…?mandant=<id>; neues Token nur einmal sichtbar; ohne ee lauffähig.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, ME_ADMIN, ME_LESER, rendereApp, type Routen } from '../../test/index';

const q = '?mandant=m-1';

const TOKEN = {
  id: 't-1',
  praefix: 'smi_abcd',
  erstellt: '2026-10-22T08:00:00Z',
  zuletzt_genutzt: null,
  widerrufen: null,
};
const ORG = {
  org_uuid: '0190a1b2-0000-7000-8000-0000000000aa',
  bezeichnung: 'Team',
  plan: 'team',
  gueltig_ab: '2026-10-01',
};
const ROLLE = {
  id: 'r-1',
  benutzer_id: 'b-1',
  benutzername: 'admin',
  rolle: 'mandanten_admin',
  projekt_ids: null,
  quelle: 'oidc',
};

function render(routen: Routen = {}, me: unknown = ME_ADMIN) {
  return rendereApp('/mandant', {
    '/api/v1/auth/me': json(me),
    [`/api/v1/mandant/tokens${q}`]: json({ tokens: [TOKEN] }),
    [`/api/v1/mandant/anthropic-orgs${q}`]: json({ orgs: [ORG] }),
    [`/api/v1/mandant/rollen${q}`]: json({ rollen: [ROLLE] }),
    ...routen,
  });
}

describe('Tokens und Orgs (Kern)', () => {
  it('zeigt Tokens, Orgs und Rollen des aktiven Mandanten; Eintrag in der Einrichtung', async () => {
    render();
    expect(await screen.findByText('smi_abcd…')).toBeTruthy();
    expect(await screen.findByText('Team')).toBeTruthy();
    expect(await screen.findByText('SSO-Gruppe')).toBeTruthy();
    const einrichtung = screen.getByRole('list', { name: 'Einrichtung' });
    expect(within(einrichtung).getByRole('link', { name: 'Tokens und Orgs' })).toBeTruthy();
    expect(within(einrichtung).getByRole('link', { name: 'SSO und Konten' })).toBeTruthy();
    // Plattform-Funktionen gibt es hier nicht.
    expect(screen.queryByRole('form', { name: 'Mandant bearbeiten' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Mandant löschen' })).toBeNull();
  });

  it('neues Token: POST mit ?mandant=, Klartext genau einmal, danach ausblendbar', async () => {
    const { aufrufe } = render({
      [`POST /api/v1/mandant/tokens${q}`]: json(
        { id: 't-2', praefix: 'smi_neu1', token: 'smi_neu1geheim' },
        201,
      ),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Neues Token erzeugen' }));
    expect(await screen.findByText('smi_neu1geheim')).toBeTruthy();
    await waitFor(() =>
      expect(
        aufrufe.some((a) => a.methode === 'POST' && a.pfad === `/api/v1/mandant/tokens${q}`),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Gespeichert, ausblenden' }));
    expect(screen.queryByText('smi_neu1geheim')).toBeNull();
  });

  it('Rolle zuweisen und Token widerrufen gehen an die Kern-Routen', async () => {
    const { aufrufe } = render({
      [`POST /api/v1/mandant/rollen${q}`]: json({ ...ROLLE, id: 'r-2' }, 201),
      [`DELETE /api/v1/mandant/tokens/t-1${q}`]: { status: 204 },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Widerrufen' }));
    const form = screen.getByRole('form', { name: 'Rolle zuweisen' });
    fireEvent.change(within(form).getByLabelText('Anmeldename (vorhandenes Konto)'), {
      target: { value: ' anna@example.org ' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Zuweisen' }));
    await waitFor(() =>
      expect(
        aufrufe.find((a) => a.methode === 'POST' && a.pfad === `/api/v1/mandant/rollen${q}`)?.body,
      ).toEqual({ benutzername: 'anna@example.org', rolle: 'controller' }),
    );
    expect(
      aufrufe.some((a) => a.methode === 'DELETE' && a.pfad === `/api/v1/mandant/tokens/t-1${q}`),
    ).toBe(true);
    expect(aufrufe.some((a) => a.pfad.startsWith('/api/v1/ee/'))).toBe(false);
  });

  it('Leser sehen den Eintrag nicht in der Navigation', async () => {
    render({}, ME_LESER);
    const nav = await screen.findByRole('navigation', { name: 'Hauptnavigation' });
    expect(within(nav).queryByRole('link', { name: 'Tokens und Orgs' })).toBeNull();
  });
});
