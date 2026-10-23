// Web-Plugins (ee) über die Plugin-Schnittstelle: Navigation, Seiten (auch ohne Navigationseintrag) und
// Übersichtskacheln. Der Kern kennt kein ee-Paket; hier steht ein Beispiel-Plugin.
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mitPluginNavigation, pluginSeiten, type WebPlugin } from './plugins';
import { json, ME_ADMIN, UEBERSICHT } from './test/fixtures';
import { rendereApp } from './test/hilfen';

const beispiel: WebPlugin = {
  name: 'beispiel',
  navigation: [
    { pfad: '/sonder', titel: 'Sonder (Plugin)', gruppe: 'einrichtung', ee: true },
    { pfad: '/extra', titel: 'Extra', gruppe: 'auswertung', ee: true },
    { pfad: '/plattform/extra', titel: 'Plattform-Extra', gruppe: 'plattform', ee: true },
  ],
  seiten: {
    '/sonder': () => <h1>Sonderseite aus dem Plugin</h1>,
    '/extra/:id': () => <h1>Extra-Detail</h1>,
    '/plattform/extra': () => <h1>Plattform-Seite aus dem Plugin</h1>,
  },
  uebersichtKacheln: [({ monat }) => <p>Kachel für {monat}</p>],
};

describe('Web-Plugins', () => {
  it('ersetzt gleiche Pfade in der Navigation und hängt neue an', () => {
    const nav = mitPluginNavigation(
      [{ pfad: '/sonder', titel: 'Sonder', gruppe: 'einrichtung', ee: true }],
      [beispiel],
    );
    expect(nav.map((e) => e.titel)).toEqual(['Sonder (Plugin)', 'Extra', 'Plattform-Extra']);
    expect(nav.map((e) => e.gruppe)).toEqual(['einrichtung', 'auswertung', 'plattform']);
    expect(Object.keys(pluginSeiten([beispiel]))).toEqual([
      '/sonder',
      '/extra/:id',
      '/plattform/extra',
    ]);
  });

  it('zeigt Plugin-Seiten statt Platzhaltern und Seiten ohne Navigationseintrag', async () => {
    rendereApp('/sonder', {}, { plugins: [beispiel] });
    expect(await screen.findByRole('heading', { name: 'Sonderseite aus dem Plugin' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Hauptnavigation' });
    expect(within(nav).getByRole('link', { name: 'Extra' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Sonder (Plugin)' })).toBeTruthy();
    // Plattform-Einträge stehen nie in der Seitenleiste.
    expect(within(nav).queryByRole('link', { name: 'Plattform-Extra' })).toBeNull();
  });

  it('hängt Plattform-Einträge in die Unternavigation des Plattform-Bereichs', async () => {
    rendereApp(
      '/plattform',
      { '/api/v1/auth/me': json({ ...ME_ADMIN, plattform_admin: true }) },
      { plugins: [beispiel] },
    );
    expect(
      await screen.findByRole('heading', { name: 'Plattform-Seite aus dem Plugin' }),
    ).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Plattform-Navigation' });
    expect(within(nav).getByRole('link', { name: 'Plattform-Extra' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Hauptnavigation' })).toBeNull();
  });

  it('rendert Detailseiten des Plugins', async () => {
    rendereApp('/extra/42', {}, { plugins: [beispiel] });
    expect(await screen.findByRole('heading', { name: 'Extra-Detail' })).toBeTruthy();
  });

  it('zeigt Plugin-Kacheln auf der Übersicht', async () => {
    rendereApp(
      '/?monat=2026-10',
      { '/api/v1/uebersicht?monat=2026-10': json(UEBERSICHT) },
      {
        plugins: [beispiel],
      },
    );
    expect(await screen.findByText('Kachel für 2026-10')).toBeTruthy();
  });
});
