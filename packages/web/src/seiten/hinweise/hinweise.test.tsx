// Seite „Projekt-Hinweise“ (Kern): Liste mit Filter, Erledigen, Regeln, Neuberechnung, 403.
import { CSRF, json, ME_LESER, MONAT, rendereApp } from '../../test/index';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HINWEIS_CACHE, HINWEISE } from '../../test/fixtures-module';

const q = `?monat=${MONAT}`;
const routen = { [`/api/v1/hinweise${q}`]: json(HINWEISE) };
const seite = `/hinweise${q}`;

describe('Projekt-Hinweise', () => {
  it('zeigt offene Hinweise mit deutschem Typ-Titel, Projekt und Beschreibung', async () => {
    rendereApp(seite, routen);
    const tabelle = await screen.findByRole('table', { name: 'Projekt-Hinweise im Monat' });
    const t = within(tabelle);
    expect(t.getByText('Prompt-Caching prüfen')).toBeTruthy();
    expect(t.getByText('Cache-Schreibkosten machen 72 % des Schattenpreises aus.')).toBeTruthy();
    expect(t.getByText('x-shop')).toBeTruthy();
    // Hinweis ohne Projekt gilt für alle Projekte; Typ „unzugeordnet“ heißt „Sitzungen ohne Git-Remote“.
    expect(t.getByText('Sitzungen ohne Git-Remote')).toBeTruthy();
    expect(t.getByText('Alle Projekte')).toBeTruthy();
    // Der erledigte Hinweis ist im Filter „Offen“ nicht dabei.
    expect(t.queryByText('Opus-Anteil hoch')).toBeNull();
  });

  it('zeigt mit „Alle“ auch erledigte Hinweise', async () => {
    rendereApp(seite, routen);
    await screen.findByRole('table', { name: 'Projekt-Hinweise im Monat' });
    expect(screen.getByRole('button', { name: 'Offen' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Alle' }));
    expect(await screen.findByText('Opus-Anteil hoch')).toBeTruthy();
    expect(screen.getByText('Erledigt am 16.10.2026')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Alle' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('meldet einen leeren Filter', async () => {
    rendereApp(seite, {
      [`/api/v1/hinweise${q}`]: json({ ...HINWEISE, hinweise: [] }),
    });
    expect(await screen.findByText('Keine offenen Hinweise in diesem Monat.')).toBeTruthy();
  });

  it('markiert einen Hinweis als erledigt (POST /erledigt mit CSRF) und lädt neu', async () => {
    let erledigt = false;
    const { aufrufe } = rendereApp(seite, {
      [`/api/v1/hinweise${q}`]: () =>
        new Response(
          JSON.stringify(
            erledigt
              ? {
                  ...HINWEISE,
                  hinweise: HINWEISE.hinweise.filter((h) => h.id !== HINWEIS_CACHE.id),
                }
              : HINWEISE,
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      [`POST /api/v1/hinweise/${HINWEIS_CACHE.id}/erledigt`]: () => {
        erledigt = true;
        return new Response(
          JSON.stringify({ ...HINWEIS_CACHE, erledigt: '2026-10-17T08:00:00.000Z' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Prompt-Caching prüfen als erledigt markieren' }),
    );
    await screen.findByRole('table', { name: 'Projekt-Hinweise im Monat' });
    await waitFor(() => expect(screen.queryByText('Prompt-Caching prüfen')).toBeNull());
    const post = aufrufe.find((a) => a.methode === 'POST');
    expect(post?.pfad).toBe(`/api/v1/hinweise/${HINWEIS_CACHE.id}/erledigt`);
    expect(post?.headers['x-seatmeter-csrf']).toBe(CSRF);
  });
});

describe('Regeln und Neuberechnung', () => {
  it('lässt Admins Schwellen ändern (PUT mit allen fünf Feldern)', async () => {
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      'PUT /api/v1/hinweise/regeln': json({ ...HINWEISE.regeln, fast_prozent: 30 }),
    });
    const formular = await screen.findByRole('form', { name: 'Schwellen ändern' });
    expect(
      (within(formular).getByLabelText('Fast-Mode-Anteil ab (%)') as HTMLInputElement).value,
    ).toBe('20');
    fireEvent.change(within(formular).getByLabelText('Fast-Mode-Anteil ab (%)'), {
      target: { value: '30' },
    });
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText(/^Gespeichert\./)).toBeTruthy();
    // Alle fünf Felder, damit der Server nicht die Standardwerte der übrigen einsetzt.
    expect(aufrufe.find((a) => a.methode === 'PUT')?.body).toEqual({
      cache_write_prozent: 60,
      fast_prozent: 30,
      opus_prozent: 80,
      unzugeordnet_prozent: 5,
      mindest_usd: 5,
    });
  });

  it('lehnt Werte außerhalb des Bereichs vorab ab', async () => {
    const { aufrufe } = rendereApp(seite, routen);
    const formular = await screen.findByRole('form', { name: 'Schwellen ändern' });
    fireEvent.change(within(formular).getByLabelText('Opus-Anteil ab (%)'), {
      target: { value: '150' },
    });
    fireEvent.click(within(formular).getByRole('button', { name: 'Speichern' }));
    expect(await within(formular).findByText('Bitte die markierten Felder prüfen.')).toBeTruthy();
    expect(aufrufe.some((a) => a.methode === 'PUT')).toBe(false);
  });

  it('berechnet die Hinweise für den Monat neu (nur Admins)', async () => {
    const { aufrufe } = rendereApp(seite, {
      ...routen,
      [`POST /api/v1/jobs/hinweise/erzeugen${q}`]: json({ hinweise: 3 }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Jetzt neu berechnen' }));
    expect(await screen.findByText('Neu berechnet: 3 Hinweise.')).toBeTruthy();
    expect(
      aufrufe.some((a) => a.methode === 'POST' && a.pfad.includes('/jobs/hinweise/erzeugen')),
    ).toBe(true);
  });

  it('zeigt Nicht-Admins die Schwellen nur lesend, ohne Neuberechnung', async () => {
    rendereApp(seite, { ...routen, '/api/v1/auth/me': json(ME_LESER) });
    await screen.findByRole('table', { name: 'Projekt-Hinweise im Monat' });
    expect(screen.getByText('Cache-Schreibanteil ab (%)')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Schwellen ändern' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Jetzt neu berechnen' })).toBeNull();
  });
});

describe('Berechtigung', () => {
  it('zeigt bei 403 den Berechtigungshinweis', async () => {
    rendereApp(seite, { [`/api/v1/hinweise${q}`]: json({ fehler: 'keine Berechtigung' }, 403) });
    expect(await screen.findByText('Keine Berechtigung.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
