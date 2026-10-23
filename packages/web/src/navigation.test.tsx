// Navigation nach Rollen (Architektur §2.4, Entscheidung 2026-10-23): Gruppen je Rolle, Kopfzeile mit
// Mandant und Rolle, Plattform-Bereich nur für Plattform-Admins, Umleitungen alter Pfade.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useParams } from 'react-router';
import { describe, expect, it } from 'vitest';
import { gruppeSichtbar, navRechte, rollenText } from './navigation';
import type { WebPlugin } from './plugins';
import { json, ME_ADMIN, ME_BETRIEBSRAT, ME_LESER } from './test/fixtures';
import { rendereApp } from './test/hilfen';

const ME_PLATTFORM = { ...ME_ADMIN, plattform_admin: true };
const EINRICHTUNG = ['Einstellungen', 'Preise & Sitzkosten', 'Ausrollen'];
const AUSWERTUNG = [
  'Übersicht',
  'Projekte',
  'Projektpreise',
  'Personen',
  'Rechner/Agenten',
  'Datenqualität',
  'Berichte',
  'Systemzustand',
];

function OrtAnzeige() {
  const { id } = useParams();
  const { pathname, search } = useLocation();
  return (
    <p>
      Ort {pathname}
      {search} id={id ?? '-'}
    </p>
  );
}

/** Test-Plugin mit Plattform-Seiten wie ee (Kern kennt kein ee-Paket). */
const plattformPlugin: WebPlugin = {
  name: 'plattform-test',
  navigation: [
    { pfad: '/plattform/mandanten', titel: 'Mandanten', gruppe: 'plattform', ee: true },
    { pfad: '/plattform/lizenz', titel: 'Lizenz', gruppe: 'plattform', ee: true },
  ],
  seiten: {
    '/plattform/mandanten': OrtAnzeige,
    '/plattform/mandanten/:id': OrtAnzeige,
    '/plattform/lizenz': OrtAnzeige,
  },
};

async function hauptnavigation() {
  return screen.findByRole('navigation', { name: 'Hauptnavigation' });
}

describe('Sichtbarkeit je Rolle (rein)', () => {
  it('leitet die Rechte aus /me ab', () => {
    expect(navRechte(ME_LESER)).toEqual({ mandantenAdmin: false, plattformAdmin: false });
    expect(navRechte(ME_ADMIN)).toEqual({ mandantenAdmin: true, plattformAdmin: false });
    expect(navRechte({ ...ME_LESER, plattform_admin: true })).toEqual({
      mandantenAdmin: false,
      plattformAdmin: true,
    });
    // Ohne Auth-Modul im Server bleibt die Einrichtung sichtbar, Plattform nicht.
    expect(navRechte(null)).toEqual({ mandantenAdmin: true, plattformAdmin: false });
  });

  it('zeigt Gruppen nur passenden Rollen', () => {
    const leser = navRechte(ME_LESER);
    const admin = navRechte(ME_ADMIN);
    const plattform = navRechte({ ...ME_LESER, plattform_admin: true });
    expect(gruppeSichtbar('auswertung', leser)).toBe(true);
    expect(gruppeSichtbar('einrichtung', leser)).toBe(false);
    expect(gruppeSichtbar('plattform', leser)).toBe(false);
    expect(gruppeSichtbar('einrichtung', admin)).toBe(true);
    expect(gruppeSichtbar('plattform', admin)).toBe(false);
    expect(gruppeSichtbar('einrichtung', plattform)).toBe(true);
    expect(gruppeSichtbar('plattform', plattform)).toBe(true);
    expect(rollenText(['mandanten_admin', 'betriebsrat'])).toBe('Mandanten-Admin, Betriebsrat');
  });
});

describe('Seitenleiste nach Rollen', () => {
  it('Controller sieht nur die Auswertung', async () => {
    rendereApp('/system', { '/api/v1/auth/me': json(ME_LESER) });
    const nav = await hauptnavigation();
    const auswertung = within(nav).getByRole('list', { name: 'Auswertung' });
    for (const titel of AUSWERTUNG)
      expect(within(auswertung).getByRole('link', { name: titel })).toBeTruthy();
    expect(within(nav).queryByRole('list', { name: 'Einrichtung' })).toBeNull();
    for (const titel of [...EINRICHTUNG, 'Budgets und Alarme', 'Abgleich'])
      expect(within(nav).queryByRole('link', { name: titel })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Plattform-Bereich' })).toBeNull();
  });

  it('Betriebsrat sieht ebenfalls nur die Auswertung', async () => {
    rendereApp('/system', { '/api/v1/auth/me': json(ME_BETRIEBSRAT) });
    const nav = await hauptnavigation();
    expect(within(nav).getByRole('link', { name: 'Berichte' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Einstellungen' })).toBeNull();
  });

  it('Mandanten-Admin sieht die Einrichtung, aber keinen Plattform-Bereich', async () => {
    rendereApp('/system', {}, { plugins: [plattformPlugin] });
    const nav = await hauptnavigation();
    const einrichtung = within(nav).getByRole('list', { name: 'Einrichtung' });
    for (const titel of [...EINRICHTUNG, 'Budgets und Alarme', 'Projekt-Hinweise', 'Abgleich'])
      expect(within(einrichtung).getByRole('link', { name: titel })).toBeTruthy();
    // Plattform-Seiten stehen nie in der Seitenleiste.
    expect(within(nav).queryByRole('link', { name: 'Mandanten' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Lizenz' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Plattform-Bereich' })).toBeNull();
  });

  it('Plattform-Admin ohne Admin-Rolle im Mandanten sieht Einrichtung und Plattform-Link', async () => {
    rendereApp(
      '/system',
      { '/api/v1/auth/me': json({ ...ME_LESER, plattform_admin: true }) },
      { plugins: [plattformPlugin] },
    );
    const nav = await hauptnavigation();
    expect(within(nav).getByRole('list', { name: 'Einrichtung' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Plattform-Bereich' }).getAttribute('href')).toBe(
      '/plattform',
    );
  });
});

describe('Kopfzeile', () => {
  it('zeigt Mandant, Anmeldename und Rolle', async () => {
    rendereApp('/system', { '/api/v1/auth/me': json(ME_LESER) });
    const kopf = await screen.findByRole('banner', { name: 'Kopfzeile' });
    expect(within(kopf).getByText('Beispiel GmbH')).toBeTruthy();
    const angemeldet = within(kopf).getByLabelText('Angemeldet als');
    expect(angemeldet.textContent).toBe('leser@example.org · Controller/Leser');
  });

  it('kennzeichnet Plattform-Admins zusätzlich mit „Plattform“', async () => {
    rendereApp('/system', { '/api/v1/auth/me': json(ME_PLATTFORM) });
    const kopf = await screen.findByRole('banner', { name: 'Kopfzeile' });
    expect(within(kopf).getByLabelText('Angemeldet als').textContent).toBe(
      'admin · Mandanten-Admin Plattform',
    );
  });

  it('wechselt den aktiven Mandanten über POST /api/v1/auth/mandant', async () => {
    const zweiter = { id: 'm-2', name: 'Kunde B GmbH', slug: 'kunde-b', rollen: ['controller'] };
    const meZwei = { ...ME_ADMIN, mandanten: [...ME_ADMIN.mandanten, zweiter] };
    const { aufrufe } = rendereApp('/system', {
      '/api/v1/auth/me': json(meZwei),
      'POST /api/v1/auth/mandant': json({
        ...meZwei,
        mandant_id: 'm-2',
        mandant: { id: 'm-2', name: 'Kunde B GmbH', slug: 'kunde-b' },
        rollen: ['controller'],
      }),
    });
    const wahl = await screen.findByRole('combobox', { name: 'Aktiver Mandant' });
    expect((wahl as HTMLSelectElement).value).toBe('m-1');
    fireEvent.change(wahl, { target: { value: 'm-2' } });
    await waitFor(() =>
      expect(aufrufe.find((a) => a.methode === 'POST')).toMatchObject({
        pfad: '/api/v1/auth/mandant',
        body: { mandant_id: 'm-2' },
      }),
    );
  });
});

describe('Plattform-Bereich', () => {
  it('Plattform-Admin: eigene Unternavigation, Start auf der ersten Seite, Link zurück', async () => {
    rendereApp(
      '/plattform',
      { '/api/v1/auth/me': json(ME_PLATTFORM) },
      { plugins: [plattformPlugin] },
    );
    expect(await screen.findByText(/Ort \/plattform\/mandanten/)).toBeTruthy();
    const unter = screen.getByRole('navigation', { name: 'Plattform-Navigation' });
    expect(within(unter).getByRole('link', { name: 'Mandanten' })).toBeTruthy();
    expect(within(unter).getByRole('link', { name: 'Lizenz' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Hauptnavigation' })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Zurück zum Dashboard' }));
    expect(await hauptnavigation()).toBeTruthy();
  });

  it('Mandanten-Admin ohne Plattform-Recht bekommt einen Hinweis statt der Seiten', async () => {
    rendereApp('/plattform/mandanten', {}, { plugins: [plattformPlugin] });
    expect(
      await screen.findByText(/Der Plattform-Bereich steht nur Plattform-Admins offen/),
    ).toBeTruthy();
    expect(screen.queryByText(/Ort /)).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Plattform-Navigation' })).toBeNull();
  });
});

describe('Umleitungen alter Pfade', () => {
  it.each([
    ['/mandanten', '/plattform/mandanten', '-'],
    ['/mandanten/m-42?x=1', '/plattform/mandanten/m-42?x=1', 'm-42'],
    ['/lizenz', '/plattform/lizenz', '-'],
  ])('%s → %s', async (alt, neu, id) => {
    rendereApp(alt, { '/api/v1/auth/me': json(ME_PLATTFORM) }, { plugins: [plattformPlugin] });
    expect(await screen.findByText(`Ort ${neu} id=${id}`)).toBeTruthy();
  });
});
