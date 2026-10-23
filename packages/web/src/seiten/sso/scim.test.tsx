// Abschnitt „SCIM“ auf der Seite „SSO und Konten“ (Fixture-fetch, nur erfundene Werte).
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { json, ME_ADMIN, rendereApp, type Routen } from '../../test/index';
import { describe, expect, it } from 'vitest';

const ME = ME_ADMIN;
/** Kern-Route der Mandantenverwaltung für den aktiven Mandanten `m-1`. */
const M = (rest: string) => `/api/v1/mandant${rest}?mandant=m-1`;

const TOKEN_AKTIV = {
  id: 't-1',
  praefix: 'sms_ab12',
  bezeichnung: 'Entra ID',
  erstellt: '2026-10-22T08:00:00.000Z',
  zuletzt_genutzt: '2026-10-23T06:00:00.000Z',
  widerrufen: null,
};
const TOKEN_ALT = {
  ...TOKEN_AKTIV,
  id: 't-0',
  praefix: 'sms_zz99',
  bezeichnung: null,
  zuletzt_genutzt: null,
  widerrufen: '2026-10-22T12:00:00.000Z',
};
const LISTE = {
  tokens: [TOKEN_AKTIV, TOKEN_ALT],
  basis_url: 'https://seatmeter.example.org/scim/v2',
  konten_synchronisiert: 7,
  gruppen_synchronisiert: 3,
  letzte_synchronisation: null,
};

function render(routen: Routen) {
  return rendereApp('/einrichtung/sso', {
    '/api/v1/auth/me': json(ME),
    [M('/oidc')]: json({ konfiguration: null, redirect_uri: null, start_url: '/x' }),
    [M('/domains')]: json({ domains: [] }),
    [M('/konten')]: json({ konten: [], kontingent: { belegt: 0, max: 5 } }),
    [M('/scim-tokens')]: json(LISTE),
    ...routen,
  });
}

describe('SCIM', () => {
  it('zeigt Basis-URL, Kennzahlen und Tokens mit Status', async () => {
    render({});
    const tabelle = await screen.findByRole('table', { name: 'SCIM-Tokens' });
    expect(within(tabelle).getByText('sms_ab12')).toBeTruthy();
    expect(within(tabelle).getByText('aktiv')).toBeTruthy();
    expect(within(tabelle).getByText(/^widerrufen am/)).toBeTruthy();
    expect(screen.getByText('https://seatmeter.example.org/scim/v2')).toBeTruthy();
    expect(screen.getByText(/Letzte Synchronisation: noch keine/)).toBeTruthy();
    expect(screen.getByText('Synchronisierte Konten: 7')).toBeTruthy();
    expect(screen.getByText('Gruppen: 3')).toBeTruthy();
    // Nur aktive Tokens haben „Widerrufen“.
    expect(screen.getAllByRole('button', { name: /^Token .* widerrufen$/ })).toHaveLength(1);
  });

  it('ohne basis_url fällt die Anzeige auf window.location.origin zurück', async () => {
    render({ [M('/scim-tokens')]: json({ ...LISTE, basis_url: null }) });
    expect(await screen.findByText(`${window.location.origin}/scim/v2`)).toBeTruthy();
  });

  it('Token erzeugen zeigt den Klartext einmal; nach Ausblenden ist er weg', async () => {
    const { aufrufe } = render({
      [`POST ${M('/scim-tokens')}`]: json(
        { ...TOKEN_AKTIV, id: 't-2', token: 'sms_geheim-beispiel' },
        201,
      ),
    });
    const form = await screen.findByRole('form', { name: 'SCIM-Token erzeugen' });
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'Entra ID' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Erzeugen' }));
    expect(await screen.findByText('sms_geheim-beispiel')).toBeTruthy();
    expect(screen.getByText(/Wird nur jetzt angezeigt/)).toBeTruthy();
    expect(aufrufe.find((a) => a.methode === 'POST' && a.pfad === M('/scim-tokens'))?.body).toEqual(
      { bezeichnung: 'Entra ID' },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Gespeichert, ausblenden' }));
    expect(screen.queryByText('sms_geheim-beispiel')).toBeNull();
  });

  it('Widerrufen fragt nach und ruft dann DELETE auf', async () => {
    const { aufrufe } = render({ [`DELETE ${M('/scim-tokens/t-1')}`]: { status: 204 } });
    fireEvent.click(await screen.findByRole('button', { name: 'Token sms_ab12 widerrufen' }));
    expect(aufrufe.some((a) => a.methode === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Token sms_ab12 endgültig widerrufen' }));
    await waitFor(() =>
      expect(aufrufe.some((a) => a.methode === 'DELETE' && a.pfad === M('/scim-tokens/t-1'))).toBe(
        true,
      ),
    );
  });
});
