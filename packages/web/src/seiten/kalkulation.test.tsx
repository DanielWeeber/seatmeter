// Phase 3 im Dashboard: EUR-Kachel, Projektpreise, Monatsabschluss, Berichte, Einstellungen, Kurs.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  BETRIEBSRAT,
  CSRF,
  json,
  KALKULATION,
  KALKULATION_OHNE_KURS,
  KALKULATION_OHNE_UEBERSCHREITUNG,
  KURSE,
  MANDANT_EINSTELLUNGEN,
  ME_BETRIEBSRAT,
  ME_LESER,
  MONAT,
  MONAT_ALT,
  MONATSABSCHLUSS,
  MONATSABSCHLUSS_OFFEN,
  PREISE,
  SITZKOSTEN,
  UEBERSICHT,
} from '../test/fixtures';
import { rendereApp } from '../test/hilfen';
import { TEXT_KEINE_BERECHTIGUNG, TEXT_UEBERSCHREITUNG_NICHT_ABGEZOGEN } from './Projektpreise';

const q = `?monat=${MONAT}`;
const qAlt = `?monat=${MONAT_ALT}`;
const VERBOTEN = json({ fehler: 'keine Berechtigung' }, 403);

describe('Übersicht: Projektpreise in EUR', () => {
  it('zeigt die EUR-Summe mit USD und Kurs', async () => {
    rendereApp(`/${q}`, {
      [`/api/v1/uebersicht${q}`]: json(UEBERSICHT),
      [`/api/v1/kalkulation${q}`]: json(KALKULATION),
    });
    expect(await screen.findByText('549,54 €')).toBeTruthy();
    const kachel = screen.getByText('Projektpreise (EUR)').parentElement as HTMLElement;
    // Intl trennt Betrag und Währung mit geschütztem Leerzeichen.
    expect(kachel.textContent).toMatch(/639,00\s\$/);
    expect(kachel.textContent).toContain('Kurs 0,8600 €/$ · EZB, vorläufig');
  });

  it('zeigt ohne Kurs einen Gedankenstrich und den Hinweis', async () => {
    rendereApp(`/${q}`, {
      [`/api/v1/uebersicht${q}`]: json(UEBERSICHT),
      [`/api/v1/kalkulation${q}`]: json(KALKULATION_OHNE_KURS),
    });
    expect(await screen.findByText(/kein Kurs für den Monat/)).toBeTruthy();
  });

  it('blendet die Kachel ohne Berechtigung aus (Betriebsrat)', async () => {
    rendereApp(`/${q}`, {
      '/api/v1/auth/me': json(ME_BETRIEBSRAT),
      [`/api/v1/uebersicht${q}`]: json(UEBERSICHT),
      [`/api/v1/kalkulation${q}`]: VERBOTEN,
    });
    expect(await screen.findByText('1.234')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Projektpreise (EUR)')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Projektpreise', () => {
  it('zeigt Tabelle, Summen, Einstellungen und CSV-Link', async () => {
    rendereApp(`/projektpreise${q}`, { [`/api/v1/kalkulation${q}`]: json(KALKULATION) });
    const tabelle = await screen.findByRole('table', { name: 'Projektpreise je Projekt' });
    const t = within(tabelle);
    expect(t.getByText('x-shop')).toBeTruthy();
    expect(t.getByText('569,46 $')).toBeTruthy();
    expect(t.getByText('489,74 €')).toBeTruthy();
    expect(t.getByText('42,60 €')).toBeTruthy();
    expect(t.getByText('Ungenutzte Sitze')).toBeTruthy();
    expect(t.getByText('17,20 €')).toBeTruthy();
    expect(t.getByText('187,46 $')).toBeTruthy();
    // Summenzeile im Tabellenfuß
    expect(t.getByText('Summe')).toBeTruthy();
    expect(t.getByText('549,54 €')).toBeTruthy();
    expect(screen.getByText('nach Nutzungsanteil je Person')).toBeTruthy();
    expect(screen.getByText('0,8600 €/$ · EZB, vorläufig')).toBeTruthy();
    expect(screen.queryByText(TEXT_UEBERSCHREITUNG_NICHT_ABGEZOGEN)).toBeNull();
    const csv = screen.getByRole('link', { name: 'CSV herunterladen' });
    expect(csv.getAttribute('href')).toBe(
      `/api/v1/berichte/projektabrechnung?monat=${MONAT}&format=csv`,
    );
  });

  it('kennzeichnet „Überschreitung nicht abgezogen“ und listet Hinweise', async () => {
    rendereApp(`/projektpreise${q}`, {
      [`/api/v1/kalkulation${q}`]: json(KALKULATION_OHNE_UEBERSCHREITUNG),
    });
    expect(await screen.findByText(TEXT_UEBERSCHREITUNG_NICHT_ABGEZOGEN)).toBeTruthy();
    expect(screen.getByText('Personen mit Nutzung ohne Sitz: 1')).toBeTruthy();
  });

  it('zeigt bei 403 nur den Berechtigungshinweis', async () => {
    rendereApp(`/projektpreise${q}`, {
      '/api/v1/auth/me': json(ME_BETRIEBSRAT),
      [`/api/v1/kalkulation${q}`]: VERBOTEN,
    });
    expect(await screen.findByText(TEXT_KEINE_BERECHTIGUNG)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'CSV herunterladen' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('schließt einen vergangenen Monat erst nach Bestätigung ab (POST mit CSRF)', async () => {
    const { aufrufe } = rendereApp(`/projektpreise${qAlt}`, {
      [`/api/v1/kalkulation${qAlt}`]: json({ ...KALKULATION, monat: MONAT_ALT }),
      [`/api/v1/monatsabschluss${qAlt}`]: json(MONATSABSCHLUSS_OFFEN),
      [`POST /api/v1/jobs/kalkulation/monatsabschluss${qAlt}`]: json({
        monat: MONAT_ALT,
        status: 'angelegt',
        zeilen: 3,
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Monat abschließen' }));
    expect(aufrufe.some((a) => a.methode === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ja, abschließen' }));
    expect(await screen.findByText('Monat abgeschlossen (3 Zeilen).')).toBeTruthy();
    const post = aufrufe.find((a) => a.methode === 'POST');
    expect(post?.pfad).toBe(`/api/v1/jobs/kalkulation/monatsabschluss${qAlt}`);
    expect(post?.headers['x-seatmeter-csrf']).toBe(CSRF);
  });

  it('zeigt den eingefrorenen Stand und erzwingt nur nach Bestätigung', async () => {
    const { aufrufe } = rendereApp(`/projektpreise${qAlt}`, {
      [`/api/v1/kalkulation${qAlt}`]: json({
        ...KALKULATION,
        monat: MONAT_ALT,
        abgeschlossen: true,
      }),
      [`/api/v1/monatsabschluss${qAlt}`]: json(MONATSABSCHLUSS),
      [`POST /api/v1/jobs/kalkulation/monatsabschluss${qAlt}&erzwingen=1`]: json({
        monat: MONAT_ALT,
        status: 'ueberschrieben',
        zeilen: 3,
      }),
    });
    expect(await screen.findByText(/Abgeschlossen am 01\.10\.2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Neu abschließen (erzwingen)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ja, überschreiben' }));
    expect(await screen.findByText('Monatsabschluss überschrieben (3 Zeilen).')).toBeTruthy();
    expect(aufrufe.find((a) => a.methode === 'POST')?.pfad).toContain('&erzwingen=1');
  });

  it('bietet Nicht-Admins keinen Abschluss an', async () => {
    rendereApp(`/projektpreise${qAlt}`, {
      '/api/v1/auth/me': json(ME_LESER),
      [`/api/v1/kalkulation${qAlt}`]: json({ ...KALKULATION, monat: MONAT_ALT }),
      [`/api/v1/monatsabschluss${qAlt}`]: json(MONATSABSCHLUSS_OFFEN),
    });
    expect(await screen.findByText(/noch nicht abgeschlossen/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Monat abschließen' })).toBeNull();
  });
});

describe('Berichte', () => {
  const routen = {
    [`/api/v1/berichte/betriebsrat${q}&format=json`]: json(BETRIEBSRAT),
  };

  it('zeigt Betriebsrats-Bericht, HTML-/CSV-Links und die Projektabrechnung', async () => {
    rendereApp(`/berichte${q}`, routen);
    expect(await screen.findByText(BETRIEBSRAT.zweck)).toBeTruthy();
    expect(
      screen.getByText('Verworfene Ereignisse mit Inhalten').nextElementSibling?.textContent,
    ).toBe('17');
    expect(screen.getByText('Gezählte Personen').nextElementSibling?.textContent).toBe('5');
    // Audit-Aktionen lesbar: Ansicht (Öffnen) und Export (Download) getrennt.
    expect(screen.getByText('Betriebsrats-Bericht heruntergeladen (CSV)')).toBeTruthy();
    expect(screen.getByText('Betriebsrats-Bericht angesehen (Dashboard oder HTML)')).toBeTruthy();
    expect(screen.getByText('Berichtsansichten').nextElementSibling?.textContent).toBe('3');
    expect(screen.getByText('Exporte (Downloads)').nextElementSibling?.textContent).toBe('7');
    expect(screen.getByText('Inhalte')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Löschläufe' })).toBeTruthy();
    expect(screen.getByText(BETRIEBSRAT.hinweis)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Als HTML öffnen' }).getAttribute('href')).toBe(
      `/api/v1/berichte/betriebsrat${q}&format=html`,
    );
    expect(screen.getByRole('link', { name: 'CSV herunterladen' }).getAttribute('href')).toBe(
      `/api/v1/berichte/betriebsrat${q}&format=csv`,
    );
    expect(
      screen
        .getByRole('link', { name: 'Projektabrechnung als CSV herunterladen' })
        .getAttribute('href'),
    ).toBe(`/api/v1/berichte/projektabrechnung${q}&format=csv`);
  });

  it('zeigt dem Betriebsrat keine Projektabrechnung', async () => {
    rendereApp(`/berichte${q}`, { ...routen, '/api/v1/auth/me': json(ME_BETRIEBSRAT) });
    expect(await screen.findByText(BETRIEBSRAT.zweck)).toBeTruthy();
    expect(
      screen.queryByRole('link', { name: 'Projektabrechnung als CSV herunterladen' }),
    ).toBeNull();
  });

  it('zeigt dem Controller nur die Projektabrechnung', async () => {
    const { aufrufe } = rendereApp(`/berichte${q}`, {
      ...routen,
      '/api/v1/auth/me': json(ME_LESER),
    });
    expect(
      await screen.findByRole('link', { name: 'Projektabrechnung als CSV herunterladen' }),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Als HTML öffnen' })).toBeNull();
    expect(aufrufe.some((a) => a.pfad.includes('/berichte/betriebsrat'))).toBe(false);
  });
});

describe('Einstellungen: Kalkulation und Datenschutz', () => {
  const routen = {
    '/api/v1/auth/mandant': json({ name: 'Beispiel GmbH', plan: 'team' }),
    '/api/v1/mandant/einstellungen': json(MANDANT_EINSTELLUNGEN),
  };
  const formular = () => screen.findByRole('form', { name: 'Einstellungen ändern' });
  const feld = (f: HTMLElement, name: string, wert: string) =>
    fireEvent.change(within(f).getByLabelText(name), { target: { value: wert } });

  it('sendet nur geänderte Felder per PUT mit CSRF-Header', async () => {
    const { aufrufe } = rendereApp('/einstellungen', {
      ...routen,
      'PUT /api/v1/mandant/einstellungen': json({
        ...MANDANT_EINSTELLUNGEN,
        sitzkosten_verteilung: 'pool',
        schatten_faktor: 1.2,
      }),
    });
    const f = await formular();
    feld(f, 'Sitzkosten-Verteilung', 'pool');
    feld(f, 'Schattenfaktor', '1,2');
    fireEvent.click(within(f).getByRole('button', { name: 'Speichern' }));
    expect(await within(f).findByText('Gespeichert.')).toBeTruthy();
    const put = aufrufe.find((a) => a.methode === 'PUT');
    expect(put?.pfad).toBe('/api/v1/mandant/einstellungen');
    expect(put?.headers['x-seatmeter-csrf']).toBe(CSRF);
    expect(put?.body).toEqual({ sitzkosten_verteilung: 'pool', schatten_faktor: 1.2 });
  });

  it('prüft Eingaben mit deutschen Meldungen ohne Anfrage', async () => {
    const { aufrufe } = rendereApp('/einstellungen', routen);
    const f = await formular();
    feld(f, 'Code-Anteil am Sitz (0 bis 1)', '1,5');
    feld(f, 'Zeitzone', 'Mond/Basis');
    fireEvent.click(within(f).getByRole('button', { name: 'Speichern' }));
    expect(await within(f).findByText('Code-Anteil höchstens 1')).toBeTruthy();
    expect(
      within(f).getByText('Unbekannte Zeitzone (IANA-Name, z. B. Europe/Berlin)'),
    ).toBeTruthy();
    expect(within(f).getByRole('alert').textContent).toContain(
      'Bitte die markierten Felder prüfen.',
    );
    expect(aufrufe.some((a) => a.methode === 'PUT')).toBe(false);
  });

  it('meldet „Keine Änderung“ ohne Anfrage', async () => {
    const { aufrufe } = rendereApp('/einstellungen', routen);
    const f = await formular();
    fireEvent.click(within(f).getByRole('button', { name: 'Speichern' }));
    expect(await within(f).findByText('Keine Änderung.')).toBeTruthy();
    expect(aufrufe.some((a) => a.methode === 'PUT')).toBe(false);
  });

  it('zeigt Prüffehler des Servers am Feld', async () => {
    rendereApp('/einstellungen', {
      ...routen,
      'PUT /api/v1/mandant/einstellungen': json(
        {
          fehler: 'ungültige Eingabe',
          details: [{ path: ['schatten_faktor'], message: 'Schattenfaktor höchstens 10' }],
        },
        400,
      ),
    });
    const f = await formular();
    feld(f, 'Schattenfaktor', '2');
    fireEvent.click(within(f).getByRole('button', { name: 'Speichern' }));
    expect(await within(f).findByText('Schattenfaktor höchstens 10')).toBeTruthy();
    expect(within(f).getByRole('alert').textContent).toContain('Speichern abgelehnt');
  });

  it('warnt beim Einschalten der Klarnamen', async () => {
    rendereApp('/einstellungen', routen);
    const f = await formular();
    fireEvent.click(within(f).getByLabelText('Klarnamen aktiv'));
    expect(within(f).getByText(/nur mit Betriebsvereinbarung/)).toBeTruthy();
  });

  it('ist für Nicht-Admins nur lesend', async () => {
    rendereApp('/einstellungen', { ...routen, '/api/v1/auth/me': json(ME_LESER) });
    expect(await screen.findByText('1 – Pseudonym, Monat')).toBeTruthy();
    expect(screen.getByText('nach Nutzungsanteil je Person')).toBeTruthy();
    expect(screen.getByText('100 %')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Einstellungen ändern' })).toBeNull();
  });
});

describe('Preise & Sitzkosten: Wechselkurs', () => {
  const routen = {
    '/api/v1/preise': json(PREISE),
    '/api/v1/sitzkosten': json(SITZKOSTEN),
    '/api/v1/kurse': json(KURSE),
  };

  it('listet Kurse je Monat mit Quelle und Stand', async () => {
    rendereApp('/preise', { ...routen, '/api/v1/auth/me': json(ME_LESER) });
    const tabelle = await screen.findByRole('table', { name: 'Wechselkurse je Monat' });
    const t = within(tabelle);
    expect(t.getByText('Oktober 2026')).toBeTruthy();
    expect(t.getByText('0,8600')).toBeTruthy();
    expect(t.getByText('EZB')).toBeTruthy();
    expect(t.getByText('vorläufig')).toBeTruthy();
    expect(t.getByText('0,868565')).toBeTruthy();
    expect(t.getByText('manuell')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Kurs manuell setzen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'EZB-Kurs abrufen' })).toBeNull();
  });

  it('setzt einen manuellen Kurs per PUT und prüft die Eingabe', async () => {
    const { aufrufe } = rendereApp('/preise', {
      ...routen,
      [`PUT /api/v1/kurs${qAlt}`]: json({
        monat: MONAT_ALT,
        usd_eur: 0.85,
        quelle: 'manuell',
        vorlaeufig: false,
        aktualisiert: '2026-10-22T10:00:00.000Z',
      }),
    });
    const f = await screen.findByRole('form', { name: 'Kurs manuell setzen' });
    fireEvent.change(within(f).getByLabelText('Monat'), { target: { value: MONAT_ALT } });
    fireEvent.change(within(f).getByLabelText('Kurs (EUR je USD)'), { target: { value: '0' } });
    fireEvent.click(within(f).getByRole('button', { name: 'Speichern' }));
    expect((await within(f).findByRole('alert')).textContent).toContain(
      'Kurs muss größer als 0 sein',
    );
    expect(aufrufe.some((a) => a.methode === 'PUT')).toBe(false);

    fireEvent.change(within(f).getByLabelText('Kurs (EUR je USD)'), { target: { value: '0,85' } });
    fireEvent.click(within(f).getByRole('button', { name: 'Speichern' }));
    expect(await within(f).findByText(/Kurs gespeichert/)).toBeTruthy();
    const put = aufrufe.find((a) => a.methode === 'PUT');
    expect(put?.pfad).toBe(`/api/v1/kurs${qAlt}`);
    expect(put?.body).toEqual({ usd_eur: 0.85 });
    expect(put?.headers['x-seatmeter-csrf']).toBe(CSRF);
  });

  it('ruft EZB-Kurse auf Knopfdruck ab', async () => {
    const { aufrufe } = rendereApp('/preise', {
      ...routen,
      'POST /api/v1/jobs/kurs/ezb': json({ monate: 3 }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'EZB-Kurs abrufen' }));
    expect(await screen.findByText('EZB-Kurse aktualisiert (3 Monate).')).toBeTruthy();
    expect(aufrufe.find((a) => a.methode === 'POST')?.pfad).toBe('/api/v1/jobs/kurs/ezb');
  });
});
