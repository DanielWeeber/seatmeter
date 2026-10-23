// Seiten mit Fixture-Antworten: Daten, Leer-, 404- und Fehlerzustände, Rollen, CSRF.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CSRF,
  DATENQUALITAET,
  MANDANT_EINSTELLUNGEN,
  json,
  ME_LESER,
  MONAT,
  PERSONEN,
  PERSONEN_ZU_WENIGE,
  PREISE,
  PROJEKT_DETAIL,
  PROJEKT_DETAIL_OHNE_PERSONEN,
  PROJEKT_DETAIL_UNZUGEORDNET,
  PROJEKT_ID,
  PROJEKT_ISSUES,
  PROJEKTE,
  RECHNER,
  SITZKOSTEN,
  SITZKOSTEN_MAX,
  UEBERSICHT,
  UEBERSICHT_LEER,
} from '../test/fixtures';
import { rendereApp } from '../test/hilfen';

const q = `?monat=${MONAT}`;

// Recharts (lazy im Projekt-Detail) einmal vorab laden: Sonst läuft der Import des großen Moduls
// in die Folgetests hinein und blockiert deren findBy-Fristen (Ursache des Timeouts bei „Personen“).
beforeAll(async () => {
  await import('../komponenten/Verlauf');
}, 30_000);

describe('Übersicht', () => {
  it('zeigt Kennzahlen, Modelle und gefilterte Anzahlen', async () => {
    rendereApp(`/${q}`, { [`/api/v1/uebersicht${q}`]: json(UEBERSICHT) });
    expect(await screen.findByText('1.234')).toBeTruthy();
    expect(screen.getByText('450.000.000')).toBeTruthy();
    expect(screen.getByText('485.000.000')).toBeTruthy();
    // Beträge kommen als Mikro-USD.
    expect(screen.getByText('419,50 $')).toBeTruthy();
    expect(screen.getByText('claude-sonnet-5-5')).toBeTruthy();
    expect(screen.getByText('161,50 $')).toBeTruthy();
    expect(screen.getByText('97,5 %')).toBeTruthy();
    expect(screen.getByText('100 %')).toBeTruthy();
    expect(screen.getByText('Fremde Organisationen').nextElementSibling?.textContent).toBe('3');
    expect((screen.getByLabelText('Monat wählen') as HTMLInputElement).value).toBe(MONAT);
  });

  it('zeigt den Leerzustand ohne Daten', async () => {
    rendereApp(`/${q}`, { [`/api/v1/uebersicht${q}`]: json(UEBERSICHT_LEER) });
    expect(await screen.findByText('Für diesen Monat liegen noch keine Daten vor.')).toBeTruthy();
  });

  it('zeigt bei 404 den Hinweis auf die fehlende Auswertung', async () => {
    rendereApp(`/${q}`, {});
    expect(await screen.findByText('Diese Auswertung liefert der Server noch nicht.')).toBeTruthy();
  });

  it('zeigt bei unerwartetem Format einen Fehler mit Wiederholen', async () => {
    rendereApp(`/${q}`, { [`/api/v1/uebersicht${q}`]: json({ monat: MONAT, anfragen: 'viele' }) });
    const fehler = await screen.findByRole('alert');
    expect(fehler.textContent).toContain('unerwartetes Format');
    expect(within(fehler).getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy();
  });

  it('wechselt mit dem Monatsknopf den Monat', async () => {
    const { aufrufe } = rendereApp(`/${q}`, {
      [`/api/v1/uebersicht${q}`]: json(UEBERSICHT),
      '/api/v1/uebersicht?monat=2026-09': json(UEBERSICHT_LEER),
    });
    await screen.findByText('1.234');
    fireEvent.click(screen.getByRole('button', { name: 'Vorheriger Monat' }));
    expect(await screen.findByText('Für diesen Monat liegen noch keine Daten vor.')).toBeTruthy();
    expect(aufrufe.map((a) => a.pfad)).toContain('/api/v1/uebersicht?monat=2026-09');
  });
});

describe('Projekte', () => {
  it('listet Projekte mit Link zum Detail', async () => {
    rendereApp(`/projekte${q}`, { [`/api/v1/projekte${q}`]: json(PROJEKTE) });
    const link = await screen.findByRole('link', { name: 'x-shop' });
    expect(link.getAttribute('href')).toBe(`/projekte/${PROJEKT_ID}${q}`);
    expect(screen.getByText('367,00 $')).toBeTruthy();
  });

  it('zeigt den Topf „unzugeordnet“ (id null) mit eigener Detail-Route', async () => {
    rendereApp(`/projekte${q}`, { [`/api/v1/projekte${q}`]: json(PROJEKTE) });
    const link = await screen.findByRole('link', { name: 'Ohne Projekt (unzugeordnet)' });
    expect(link.getAttribute('href')).toBe(`/projekte/unzugeordnet${q}`);
    expect(screen.getByText('1,00 $')).toBeTruthy();
    // Personenzahl nur ohne Hinweis; unter der Mindestgruppe steht „zu wenige“.
    expect(screen.getByText('zu wenige')).toBeTruthy();
  });

  it('zeigt das Detail mit Modellen und Personen', async () => {
    rendereApp(`/projekte/${PROJEKT_ID}${q}`, {
      [`/api/v1/projekte/${PROJEKT_ID}${q}`]: json(PROJEKT_DETAIL),
    });
    expect(await screen.findByRole('heading', { name: 'x-shop' })).toBeTruthy();
    expect(screen.getByText('git.example.org/beispiel/x-shop')).toBeTruthy();
    expect(screen.getByText('claude-opus-5-5')).toBeTruthy();
    expect(screen.getByText('P-K7Q2MX')).toBeTruthy();
    expect(screen.getByText('02.10.2026')).toBeTruthy();
    expect(screen.getByText('1,50 $')).toBeTruthy();
  });

  it('zeigt Issues mit Anteil, Rest ohne Schlüssel und CSV-Link', async () => {
    rendereApp(`/projekte/${PROJEKT_ID}${q}`, {
      [`/api/v1/projekte/${PROJEKT_ID}${q}`]: json(PROJEKT_DETAIL),
      [`/api/v1/projekte/${PROJEKT_ID}/issues${q}`]: json(PROJEKT_ISSUES),
    });
    const tabelle = await screen.findByRole('table', { name: 'Kosten je Issue' });
    expect(within(tabelle).getByText('ABC-123')).toBeTruthy();
    expect(within(tabelle).getByText('ohne Issue-Schlüssel')).toBeTruthy();
    expect(within(tabelle).getByText(/^50\s%$/)).toBeTruthy();
    const csv = screen.getByRole('link', { name: 'Issues als CSV herunterladen' });
    expect(csv.getAttribute('href')).toBe(`/api/v1/projekte/${PROJEKT_ID}/issues${q}&format=csv`);
  });

  it('zeigt den Hinweis zur Schlüsselerkennung, wenn keine Issues vorliegen', async () => {
    rendereApp(`/projekte/${PROJEKT_ID}${q}`, {
      [`/api/v1/projekte/${PROJEKT_ID}${q}`]: json(PROJEKT_DETAIL),
      [`/api/v1/projekte/${PROJEKT_ID}/issues${q}`]: json({ ...PROJEKT_ISSUES, issues: [] }),
    });
    expect(await screen.findByText(/Keine Issue-Schlüssel erkannt/)).toBeTruthy();
  });

  it('zeigt statt Personen den Hinweis, wenn der Server personen: null schickt', async () => {
    rendereApp(`/projekte/${PROJEKT_ID}${q}`, {
      [`/api/v1/projekte/${PROJEKT_ID}${q}`]: json(PROJEKT_DETAIL_OHNE_PERSONEN),
    });
    await screen.findByRole('heading', { name: 'x-shop' });
    expect(screen.getByText('Ihre Rolle sieht keine Personenwerte.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Personen im Projekt' })).toBeNull();
    expect(screen.queryByText('P-K7Q2MX')).toBeNull();
  });

  it('zeigt das Detail des Topfs „unzugeordnet“', async () => {
    const { aufrufe } = rendereApp(`/projekte/unzugeordnet${q}`, {
      [`/api/v1/projekte/unzugeordnet${q}`]: json(PROJEKT_DETAIL_UNZUGEORDNET),
    });
    expect(
      await screen.findByRole('heading', { name: 'Ohne Projekt (unzugeordnet)' }),
    ).toBeTruthy();
    expect(screen.getByText('claude-haiku-5')).toBeTruthy();
    expect(screen.getByText('Kein Tagesverlauf vorhanden.')).toBeTruthy();
    expect(screen.getByText(/Zu wenige Personen für eine Auswertung/)).toBeTruthy();
    expect(aufrufe.map((a) => a.pfad)).toContain(`/api/v1/projekte/unzugeordnet${q}`);
  });
});

describe('Personen', () => {
  it('zeigt Pseudonyme', async () => {
    rendereApp(`/personen${q}`, { [`/api/v1/personen${q}`]: json(PERSONEN) });
    const tabelle = await screen.findByRole('table', { name: 'Personen im Monat' });
    expect(within(tabelle).getByText('P-K7Q2MX')).toBeTruthy();
    expect(within(tabelle).getByText('1,50 $')).toBeTruthy();
  });

  it('zeigt bei personen: null nur den Hinweis des Servers', async () => {
    rendereApp(`/personen${q}`, { [`/api/v1/personen${q}`]: json(PERSONEN_ZU_WENIGE) });
    expect(
      await screen.findByText(
        'Zu wenige Personen für eine Auswertung – erst ab drei Personen sichtbar (Schutz vor Rückschlüssen).',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('zeigt bei 403 rolle_fehlt den Rollen-Hinweis statt eines Fehlers', async () => {
    rendereApp(`/personen${q}`, {
      [`/api/v1/personen${q}`]: json(
        { code: 'rolle_fehlt', fehler: 'Rolle ohne Personensicht' },
        403,
      ),
    });
    expect(await screen.findByText('Ihre Rolle sieht keine Personenwerte.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Datenqualität', () => {
  it('zeigt Abdeckung, Datenempfang, Kontrollsumme und Modelle ohne Preis', async () => {
    rendereApp(`/datenqualitaet${q}`, {
      [`/api/v1/datenqualitaet${q}`]: json(DATENQUALITAET),
    });
    expect(await screen.findByText('84 %')).toBeTruthy();
    expect(screen.getByText('Beide Quellen').nextElementSibling?.textContent).toBe('100');
    expect(screen.getByText('Heuristisch zusammengeführt').nextElementSibling?.textContent).toBe(
      '3',
    );
    expect(screen.getByText('99,5 %')).toBeTruthy();
    expect(screen.getByText('Quelle B (Agent)')).toBeTruthy();
    expect(screen.getByText('claude-neu-1')).toBeTruthy();
  });
});

describe('Preise & Sitzkosten', () => {
  const routen = {
    '/api/v1/preise': json(PREISE),
    '/api/v1/sitzkosten': json(SITZKOSTEN),
  };

  it('liest { zeilen } und ist für Nicht-Admins nur lesend', async () => {
    rendereApp('/preise', { ...routen, '/api/v1/auth/me': json(ME_LESER) });
    expect(await screen.findByText('claude-opus-5-5')).toBeTruthy();
    expect(screen.getAllByText('0,20 $').length).toBeGreaterThan(0);
    expect(screen.getByText('eigene Zeile')).toBeTruthy();
    expect(screen.getByText('jährlich')).toBeTruthy();
    expect(screen.getByText('100,00 $')).toBeTruthy();
    expect(screen.getByText('Nur lesend. Änderungen nehmen Mandanten-Admins vor.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Neue Preiszeile' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
  });

  it('erlaubt Admins neue Preiszeilen (POST mit CSRF-Header)', async () => {
    const { aufrufe } = rendereApp('/preise', {
      ...routen,
      'POST /api/v1/preise': json({ id: 'pr-2' }, 201),
    });
    const formular = await screen.findByRole('form', { name: 'Neue Preiszeile' });
    const feld = (name: string, wert: string) =>
      fireEvent.change(within(formular).getByLabelText(name), { target: { value: wert } });
    feld('Modell-Präfix', 'Claude-Haiku-5');
    feld('Gültig ab', '2026-11-01');
    feld('Input (USD je MTok)', '1');
    feld('Output (USD je MTok)', '5');
    feld('Cache lesen (USD je MTok)', '0,1');
    feld('Cache schreiben 5 min (USD je MTok)', '1,25');
    feld('Cache schreiben 1 h (USD je MTok)', '2');
    feld('Quelle (URL)', 'https://example.org/preise');
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(aufrufe.some((a) => a.methode === 'POST')).toBe(true));
    const post = aufrufe.find((a) => a.methode === 'POST');
    expect(post?.pfad).toBe('/api/v1/preise');
    expect(post?.headers['x-seatmeter-csrf']).toBe(CSRF);
    expect(post?.body).toMatchObject({
      modell_praefix: 'claude-haiku-5',
      gueltig_ab: '2026-11-01',
      saetze: { input: 1, output: 5, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 },
      quelle_url: 'https://example.org/preise',
    });
    expect(post?.body).not.toHaveProperty('mandant_id');
  });

  it('zeigt die Sitztypen Max 5x und Max 20x mit ihren Standardpreisen', async () => {
    rendereApp('/preise', { ...routen, '/api/v1/sitzkosten': json(SITZKOSTEN_MAX) });
    const tabelle = await screen.findByRole('table', { name: 'Sitzkosten' });
    expect(within(tabelle).getByText('Max 5x')).toBeTruthy();
    expect(within(tabelle).getByText('Max 20x')).toBeTruthy();
    expect(within(tabelle).getByText('100,00 $')).toBeTruthy();
    expect(within(tabelle).getByText('200,00 $')).toBeTruthy();
    const formular = screen.getByRole('form', { name: 'Neue Sitzkosten' });
    const optionen = within(formular)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(optionen).toEqual(expect.arrayContaining(['Max 5x', 'Max 20x']));
    expect(optionen).not.toContain('Max');
  });

  it('speichert Sitzkosten per PUT mit CSRF-Header', async () => {
    const { aufrufe } = rendereApp('/preise', {
      ...routen,
      'PUT /api/v1/sitzkosten': json({ geaendert: 1 }),
    });
    const formular = await screen.findByRole('form', { name: 'Neue Sitzkosten' });
    const feld = (name: string, wert: string) =>
      fireEvent.change(within(formular).getByLabelText(name), { target: { value: wert } });
    feld('Sitztyp', 'premium');
    feld('Gültig ab', '2026-11-01');
    feld('Preis je Monat', '120,50');
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(aufrufe.some((a) => a.methode === 'PUT')).toBe(true));
    const put = aufrufe.find((a) => a.methode === 'PUT');
    expect(put?.pfad).toBe('/api/v1/sitzkosten');
    expect(put?.headers['x-seatmeter-csrf']).toBe(CSRF);
    expect(put?.body).toEqual({
      sitz_typ: 'premium',
      gueltig_ab: '2026-11-01',
      preis_monat: 120.5,
      waehrung: 'USD',
      abrechnung: 'jaehrlich',
    });
    expect(aufrufe.some((a) => a.methode === 'POST')).toBe(false);
  });

  it('meldet unvollständige Preiszeilen ohne Anfrage', async () => {
    const { aufrufe } = rendereApp('/preise', routen);
    const formular = await screen.findByRole('form', { name: 'Neue Preiszeile' });
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    expect(await within(formular).findByRole('alert')).toBeTruthy();
    expect(aufrufe.some((a) => a.methode === 'POST')).toBe(false);
  });
});

describe('Rechner/Agenten', () => {
  it('zeigt den Einmalcode genau einmal', async () => {
    let zaehler = 0;
    rendereApp('/rechner', {
      '/api/v1/rechner': json(RECHNER),
      'POST /api/v1/rechner/einmalcode': () =>
        Response.json({ code: `CODE-${++zaehler}`, laeuft_ab: '2026-10-23T10:00:00Z' }),
    });
    expect(await screen.findByText('Notebook 1')).toBeTruthy();
    expect(screen.getByText('22.10.2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Einmalcode erzeugen' }));
    expect((await screen.findByTestId('einmalcode')).textContent).toBe('CODE-1');
    expect(screen.getByText('seatmeter-agent enroll CODE-1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kopieren' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Ausblenden' }));
    expect(screen.queryByTestId('einmalcode')).toBeNull();
    expect(screen.queryByText(/CODE-1/)).toBeNull();
  });

  it('widerruft erst nach Bestätigung (POST mit CSRF-Header)', async () => {
    const { aufrufe } = rendereApp('/rechner', {
      '/api/v1/rechner': json(RECHNER),
      'POST /api/v1/rechner/r-1/widerrufen': json(null, 204),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Notebook 1 widerrufen' }));
    expect(aufrufe.some((a) => a.methode === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ja, widerrufen' }));
    await waitFor(() =>
      expect(aufrufe.some((a) => a.pfad === '/api/v1/rechner/r-1/widerrufen')).toBe(true),
    );
    const post = aufrufe.find((a) => a.pfad === '/api/v1/rechner/r-1/widerrufen');
    expect(post?.headers['x-seatmeter-csrf']).toBe(CSRF);
  });

  it('zeigt Nicht-Admins keine Verwaltung', async () => {
    rendereApp('/rechner', {
      '/api/v1/rechner': json(RECHNER),
      '/api/v1/auth/me': json(ME_LESER),
    });
    await screen.findByText('Notebook 1');
    expect(screen.queryByRole('button', { name: 'Einmalcode erzeugen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Notebook 1 widerrufen' })).toBeNull();
  });
});

describe('Einstellungen', () => {
  it('zeigt Mandant und Anmeldestatus', async () => {
    rendereApp('/einstellungen', {
      '/api/v1/auth/me': json(ME_LESER),
      '/api/v1/auth/mandant': json({
        name: 'Beispiel GmbH',
        plan: 'team',
        auswertungsstufe: 1,
        klarnamen_aktiv: false,
        zeitzone: 'Europe/Berlin',
        waehrung: 'EUR',
        sitzkosten_verteilung: 'person',
        aufbewahrung_anfrage_tage: 90,
      }),
      '/api/v1/mandant/einstellungen': json(MANDANT_EINSTELLUNGEN),
    });
    expect(await screen.findByText('1 – Pseudonym, Monat')).toBeTruthy();
    expect(screen.getByText('90 Tage')).toBeTruthy();
    expect(screen.getByText('Controller/Leser')).toBeTruthy();
    expect(screen.getByText('Vertrauenswürdiger Proxy')).toBeTruthy();
    // Beim Proxy-Header-Modus meldet der Proxy ab, nicht seatmeter.
    expect(screen.queryByRole('button', { name: 'Abmelden' })).toBeNull();
  });
});
