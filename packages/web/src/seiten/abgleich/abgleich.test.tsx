// Seite „Abgleich“ (Kern): Status, Läufe mit Tagen, Analytics-Key, „Jetzt abgleichen“, CSV-Import, 403.
import { CSRF, json, ME_LESER, rendereApp } from '../../test/index';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ABGLEICH_LAEUFE,
  ABGLEICH_STATUS,
  ABGLEICH_STATUS_TEAM,
  CSV_TEXT,
  CSV_VORSCHAU,
  LAUF_API,
  LAUF_CSV,
} from '../../test/fixtures-module';

const routen = {
  '/api/v1/abgleich': json(ABGLEICH_STATUS),
  '/api/v1/abgleich/laeufe': json(ABGLEICH_LAEUFE),
};

describe('Abgleich: Stand und Läufe', () => {
  it('zeigt Plan, Key-Status, letzten Lauf und die Erklärung', async () => {
    rendereApp('/abgleich', routen);
    expect(await screen.findByText('Enterprise')).toBeTruthy();
    expect(screen.getByText('hinterlegt')).toBeTruthy();
    expect(screen.getByText(/Abweichungen · 01\.10\.2026 – 14\.10\.2026/)).toBeTruthy();
    expect(screen.getByText(/^Enterprise: Analytics-API-Key/)).toBeTruthy();
    expect(screen.getByText(/Spend-Report-CSV\. Ohne Abgleich/)).toBeTruthy();
  });

  it('listet die Läufe mit Kennzahlen, Überschreitung und Fehler', async () => {
    rendereApp('/abgleich', routen);
    const tabelle = await screen.findByRole('table', { name: 'Läufe des Abgleichs' });
    const t = within(tabelle);
    const zeilen = t.getAllByRole('row');
    // Kopfzeile + drei Läufe
    expect(zeilen).toHaveLength(4);
    const api = within(zeilen[1] as HTMLElement);
    expect(api.getByText('Analytics-API')).toBeTruthy();
    expect(api.getByText('96,7 %')).toBeTruthy(); // Abdeckung
    expect(api.getByText('42,50 $')).toBeTruthy(); // Überschreitung
    expect(api.getByText('Abweichungen')).toBeTruthy();
    const csv = within(zeilen[2] as HTMLElement);
    expect(csv.getByText('CSV')).toBeTruthy();
    expect(csv.getByText('In Ordnung')).toBeTruthy();
    expect(t.getByText('Analytics-API antwortete mit Status 401')).toBeTruthy();
  });

  it('klappt die Tageswerte eines Laufs auf und zu', async () => {
    rendereApp('/abgleich', routen);
    const tabelle = await screen.findByRole('table', { name: 'Läufe des Abgleichs' });
    // Nur der API-Lauf hat Tage.
    const knoepfe = within(tabelle).getAllByRole('button', { name: 'Tage anzeigen' });
    expect(knoepfe).toHaveLength(1);
    fireEvent.click(knoepfe[0] as HTMLElement);
    const tage = await screen.findByRole('table', { name: 'Tageswerte des Laufs' });
    expect(within(tage).getByText('01.10.2026')).toBeTruthy();
    expect(within(tage).getByText('8.000.000')).toBeTruthy();
    expect(within(tage).getByText('-5 %')).toBeTruthy();
    fireEvent.click(within(tabelle).getByRole('button', { name: 'Tage ausblenden' }));
    expect(screen.queryByRole('table', { name: 'Tageswerte des Laufs' })).toBeNull();
  });

  it('zeigt Nicht-Admins nur Stand und Läufe', async () => {
    rendereApp('/abgleich', { ...routen, '/api/v1/auth/me': json(ME_LESER) });
    await screen.findByRole('table', { name: 'Läufe des Abgleichs' });
    expect(screen.queryByRole('button', { name: 'Jetzt abgleichen' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Vorschau' })).toBeNull();
    expect(screen.queryByLabelText(/Analytics-API-Key \(Scope/)).toBeNull();
  });
});

describe('Abgleich: Analytics-API-Key und Lauf', () => {
  it('startet „Jetzt abgleichen“ mit Zeitraum und zeigt das Ergebnis', async () => {
    const { aufrufe } = rendereApp('/abgleich', {
      ...routen,
      'POST /api/v1/abgleich/lauf?von=2026-10-01&bis=2026-10-14': json(LAUF_API),
    });
    await screen.findByText('Enterprise');
    fireEvent.change(screen.getByLabelText('Von (optional)'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Bis (optional)'), { target: { value: '2026-10-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt abgleichen' }));
    const ergebnis = await screen.findByRole('status', { name: 'Ergebnis des Abgleichs' });
    expect(within(ergebnis).getByText('Abweichungen')).toBeTruthy();
    expect(within(ergebnis).getByText('42,50 $')).toBeTruthy();
    const post = aufrufe.find((a) => a.methode === 'POST');
    expect(post?.pfad).toBe('/api/v1/abgleich/lauf?von=2026-10-01&bis=2026-10-14');
    expect(post?.headers['x-seatmeter-csrf']).toBe(CSRF);
  });

  it('startet ohne Zeitraum ohne Query', async () => {
    const { aufrufe } = rendereApp('/abgleich', {
      ...routen,
      'POST /api/v1/abgleich/lauf': json(LAUF_API),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Jetzt abgleichen' }));
    await screen.findByRole('status', { name: 'Ergebnis des Abgleichs' });
    expect(aufrufe.find((a) => a.methode === 'POST')?.pfad).toBe('/api/v1/abgleich/lauf');
  });

  it('sperrt „Jetzt abgleichen“ ohne Key', async () => {
    rendereApp('/abgleich', { ...routen, '/api/v1/abgleich': json(ABGLEICH_STATUS_TEAM) });
    const knopf = (await screen.findByRole('button', {
      name: 'Jetzt abgleichen',
    })) as HTMLButtonElement;
    expect(knopf.disabled).toBe(true);
    expect(screen.getByText('Erst einen Analytics-API-Key hinterlegen.')).toBeTruthy();
    expect(screen.getByText('nicht hinterlegt')).toBeTruthy();
  });

  it('speichert den Key per PUT und zeigt ihn nie an', async () => {
    const KEY = 'sk-ant-test.geheim.0123456789';
    const { aufrufe } = rendereApp('/abgleich', {
      ...routen,
      '/api/v1/abgleich': json(ABGLEICH_STATUS_TEAM),
      'PUT /api/v1/abgleich/analytics-key': json(ABGLEICH_STATUS),
    });
    const feld = (await screen.findByLabelText(
      'Analytics-API-Key (Scope read:analytics)',
    )) as HTMLInputElement;
    expect(feld.type).toBe('password');
    fireEvent.change(feld, { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Key speichern' }));
    expect(await screen.findByText('Key gespeichert.')).toBeTruthy();
    expect(aufrufe.find((a) => a.methode === 'PUT')?.body).toEqual({ key: KEY });
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
    expect(document.body.textContent).not.toContain(KEY);
    // Status kommt aus der PUT-Antwort: Key hinterlegt, „Jetzt abgleichen“ frei.
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Jetzt abgleichen' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it('weist einen zu kurzen Key vorab ab', async () => {
    const { aufrufe } = rendereApp('/abgleich', routen);
    const feld = await screen.findByLabelText('Analytics-API-Key (Scope read:analytics)');
    expect((feld as HTMLInputElement).placeholder).toBe('unverändert');
    fireEvent.change(feld, { target: { value: 'kurz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Key ersetzen' }));
    expect(
      await screen.findByText('Bitte den Analytics-API-Key einfügen (mindestens 20 Zeichen).'),
    ).toBeTruthy();
    expect(aufrufe.some((a) => a.methode === 'PUT')).toBe(false);
  });

  it('entfernt den Key erst nach Bestätigung (DELETE)', async () => {
    const { aufrufe } = rendereApp('/abgleich', {
      ...routen,
      'DELETE /api/v1/abgleich/analytics-key': { status: 204 },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Key entfernen' }));
    expect(aufrufe.some((a) => a.methode === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ja, entfernen' }));
    expect(await screen.findByText('Key entfernt.')).toBeTruthy();
    expect(aufrufe.find((a) => a.methode === 'DELETE')?.pfad).toBe(
      '/api/v1/abgleich/analytics-key',
    );
  });
});

describe('Abgleich: CSV-Import', () => {
  const PFAD_VORSCHAU = 'POST /api/v1/abgleich/csv/vorschau';

  /** Vorschau-Route: antwortet mit der erkannten Zuordnung, nach Korrektur mit der korrigierten. */
  const vorschauRoute = (init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { zuordnung?: { modell?: string | null } };
    const antwort = body.zuordnung?.modell
      ? { ...CSV_VORSCHAU, zuordnung: { ...CSV_VORSCHAU.zuordnung, modell: body.zuordnung.modell } }
      : CSV_VORSCHAU;
    return new Response(JSON.stringify(antwort), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  it('zeigt die Vorschau, übernimmt die korrigierte Zuordnung und importiert sie', async () => {
    const { aufrufe } = rendereApp('/abgleich', {
      ...routen,
      [PFAD_VORSCHAU]: vorschauRoute,
      'POST /api/v1/abgleich/csv': json(LAUF_CSV),
    });
    fireEvent.change(await screen.findByLabelText('oder CSV-Text einfügen'), {
      target: { value: CSV_TEXT },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Vorschau' }));

    // Vorschau: Trennzeichen, Zähler, Fehler, maskierte Beispielzeile
    expect(await screen.findByText('Semikolon (;)')).toBeTruthy();
    expect(screen.getByText('Zeile 17: ungültiges Datum')).toBeTruthy();
    expect(screen.getByText('a***@example.com')).toBeTruthy();
    expect(screen.getByText('345,67 $')).toBeTruthy();
    const zeitraum = screen.getAllByText('Zeitraum').find((e) => e.tagName === 'DT');
    expect(zeitraum?.nextElementSibling?.textContent).toBe('01.10.2026 – 14.10.2026');
    // Erste Anfrage ohne Zuordnung: der Server erkennt sie.
    const erste = aufrufe.find((a) => a.pfad === '/api/v1/abgleich/csv/vorschau');
    expect(erste?.body).toEqual({ csv: CSV_TEXT });

    // Erkannte Zuordnung ist vorbelegt; Modell fehlt und wird korrigiert.
    const tag = screen.getByLabelText('Tag') as HTMLSelectElement;
    expect(tag.value).toBe('Datum');
    const modell = screen.getByLabelText('Modell') as HTMLSelectElement;
    expect(modell.value).toBe('');
    fireEvent.change(modell, { target: { value: 'Modell' } });
    await waitFor(() =>
      expect(aufrufe.filter((a) => a.pfad === '/api/v1/abgleich/csv/vorschau')).toHaveLength(2),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Importieren' }));
    const ergebnis = await screen.findByRole('status', { name: 'Ergebnis des Abgleichs' });
    expect(within(ergebnis).getByText('CSV')).toBeTruthy();
    expect(within(ergebnis).getByText('In Ordnung')).toBeTruthy();
    const import_ = aufrufe.find((a) => a.pfad === '/api/v1/abgleich/csv');
    expect(import_?.methode).toBe('POST');
    expect(import_?.headers['x-seatmeter-csrf']).toBe(CSRF);
    expect(import_?.body).toEqual({
      csv: CSV_TEXT,
      zuordnung: {
        email: 'E-Mail',
        tag: 'Datum',
        modell: 'Modell',
        amount: 'Betrag (USD)',
        list_amount: null,
        input: 'Tokens Eingabe',
        output: null,
        cache_read: null,
        cache_write: null,
      },
    });
    // Nach dem Import ist die Vorschau weg und die Läufe werden neu geladen.
    expect(screen.queryByRole('button', { name: 'Importieren' })).toBeNull();
    await waitFor(() =>
      expect(aufrufe.filter((a) => a.pfad === '/api/v1/abgleich/laeufe').length).toBe(2),
    );
  });

  it('liest eine CSV-Datei im Browser und sendet die Betragseinheit mit', async () => {
    const { aufrufe } = rendereApp('/abgleich', { ...routen, [PFAD_VORSCHAU]: vorschauRoute });
    const eingabe = (await screen.findByLabelText('CSV-Datei wählen')) as HTMLInputElement;
    const datei = new File([CSV_TEXT], 'spend.csv', { type: 'text/csv' });
    fireEvent.change(eingabe, { target: { files: [datei] } });
    expect(await screen.findByText(/Datei „spend\.csv“ geladen/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Betragseinheit'), { target: { value: 'cent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vorschau' }));
    await screen.findByText('Semikolon (;)');
    expect(aufrufe.find((a) => a.pfad === '/api/v1/abgleich/csv/vorschau')?.body).toEqual({
      csv: CSV_TEXT,
      betrag_einheit: 'cent',
    });
  });

  it('zeigt einen abgelehnten Import als Fehler', async () => {
    rendereApp('/abgleich', {
      ...routen,
      [PFAD_VORSCHAU]: json(CSV_VORSCHAU),
      'POST /api/v1/abgleich/csv': json({ fehler: 'csv_ungueltig' }, 400),
    });
    fireEvent.change(await screen.findByLabelText('oder CSV-Text einfügen'), {
      target: { value: CSV_TEXT },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Vorschau' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Importieren' }));
    expect(await screen.findByText(/Speichern fehlgeschlagen: csv_ungueltig/)).toBeTruthy();
  });
});

describe('Abgleich: Berechtigung', () => {
  it('zeigt bei 403 den Berechtigungshinweis', async () => {
    rendereApp('/abgleich', { '/api/v1/abgleich': json({ fehler: 'keine Berechtigung' }, 403) });
    expect(await screen.findByText('Keine Berechtigung.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
