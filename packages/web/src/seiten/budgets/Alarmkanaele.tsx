// Abschnitt „Alarmkanäle“ (nur Admins): Kanäle anlegen, bearbeiten, testen und löschen.
// Routen: /api/v1/alarmkanal (GET/POST/PUT/DELETE) und POST …/:id/test.
import { kanalTestErgebnisSchema, type Kanal } from '@seatmeter/shared';
import { useApi } from '../../api/client';
import { Abschnitt, Tabelle, type Spalte } from '../../komponenten/Bausteine';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KNOPF, KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { ZugriffAbfrage, speicherFehler } from '../../komponenten/Zugriff';
import { useKanaele } from './abfragen';
import { KANAL_TYP_TEXT, KanalFormular } from './KanalFormular';

const text = (w: unknown): string => (typeof w === 'string' ? w : '');

/** Ziel eines Kanals in einer Zeile (URL bzw. Mailserver und Empfänger), nie das Geheimnis. */
export function kanalZiel(k: Kanal): string {
  const c = k.konfig;
  if (k.typ === 'smtp') {
    const an = Array.isArray(c.an) ? c.an.map(text).join(', ') : '';
    return `${text(c.host)}:${String(c.port ?? '')} → ${an}`;
  }
  if (k.typ === 'weeberwrk-relay') return `${text(c.url)}${text(c.pfad)}`;
  return text(c.url);
}

interface TestStand {
  name: string;
  ok: boolean;
  meldung: string;
}

export function Alarmkanaele() {
  const api = useApi();
  const queryClient = useQueryClient();
  const abfrage = useKanaele();
  const [formular, setFormular] = useState<Kanal | 'neu' | null>(null);
  const [loeschenFrage, setLoeschenFrage] = useState<string | null>(null);
  const [erfolg, setErfolg] = useState<string | null>(null);
  const [test, setTest] = useState<TestStand | null>(null);

  const testen = useMutation({
    mutationFn: (kanal: Kanal) =>
      api.post(
        `/api/v1/alarmkanal/${encodeURIComponent(kanal.id)}/test`,
        undefined,
        kanalTestErgebnisSchema,
      ),
    onMutate: () => setTest(null),
    onSuccess: (ergebnis, kanal) =>
      setTest({ name: kanal.bezeichnung, ok: ergebnis.ok, meldung: ergebnis.meldung }),
  });
  const loeschen = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/alarmkanal/${encodeURIComponent(id)}`),
    onSuccess: async () => {
      setLoeschenFrage(null);
      setErfolg('Alarmkanal gelöscht.');
      await queryClient.invalidateQueries({ queryKey: ['alarmkanal'] });
    },
  });

  const spalten: Spalte<Kanal>[] = [
    {
      titel: 'Kanal',
      wert: (k) => (
        <>
          <span className="font-medium">{k.bezeichnung}</span>
          {!k.aktiv && <span className="ml-2 text-xs text-slate-500">(inaktiv)</span>}
        </>
      ),
    },
    { titel: 'Typ', wert: (k) => KANAL_TYP_TEXT[k.typ] },
    { titel: 'Ziel', wert: (k) => <span className="break-all text-xs">{kanalZiel(k)}</span> },
    { titel: 'Geheimnis', wert: (k) => (k.geheimnis_gesetzt ? 'gesetzt' : 'nicht gesetzt') },
    {
      titel: 'Aktionen',
      wert: (k) =>
        loeschenFrage === k.id ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-700">Kanal wirklich löschen?</span>
            <button
              type="button"
              className={KNOPF_KLEIN}
              disabled={loeschen.isPending}
              onClick={() => loeschen.mutate(k.id)}
            >
              Ja, löschen
            </button>
            <button type="button" className={KNOPF_KLEIN} onClick={() => setLoeschenFrage(null)}>
              Abbrechen
            </button>
          </span>
        ) : (
          <span className="flex flex-wrap gap-2">
            <button
              type="button"
              className={KNOPF_KLEIN}
              disabled={testen.isPending}
              aria-label={`Kanal ${k.bezeichnung} testen`}
              onClick={() => testen.mutate(k)}
            >
              Testen
            </button>
            <button
              type="button"
              className={KNOPF_KLEIN}
              aria-label={`Kanal ${k.bezeichnung} bearbeiten`}
              onClick={() => {
                setErfolg(null);
                setFormular(k);
              }}
            >
              Bearbeiten
            </button>
            <button
              type="button"
              className={KNOPF_KLEIN}
              aria-label={`Kanal ${k.bezeichnung} löschen`}
              onClick={() => setLoeschenFrage(k.id)}
            >
              Löschen
            </button>
          </span>
        ),
    },
  ];

  return (
    <Abschnitt titel="Alarmkanäle">
      <p className="mb-2 text-sm text-slate-600">
        Hierhin gehen die Alarme: Webhook, E-Mail oder das weeberwrk-Relay. Ohne aktiven Kanal
        bleiben Alarme in der Liste stehen („Kein Alarmkanal“).
      </p>
      <ZugriffAbfrage
        abfrage={abfrage}
        istLeer={(d) => d.kanaele.length === 0}
        leerText="Noch keine Alarmkanäle angelegt."
      >
        {(d) => (
          <Tabelle
            beschriftung="Alarmkanäle"
            spalten={spalten}
            zeilen={d.kanaele}
            schluessel={(k) => k.id}
          />
        )}
      </ZugriffAbfrage>
      {test && (
        <p role="status" className={`mt-2 text-sm ${test.ok ? 'text-green-800' : 'text-red-800'}`}>
          Test „{test.name}“: {test.ok ? 'ok' : 'fehlgeschlagen'} – {test.meldung}
        </p>
      )}
      {(testen.isError || loeschen.isError) && (
        <p role="alert" className="mt-2 text-sm text-red-800">
          {speicherFehler(testen.error ?? loeschen.error)}
        </p>
      )}
      {erfolg && (
        <p role="status" className="mt-2 text-sm text-green-800">
          {erfolg}
        </p>
      )}
      {!abfrage.isError && formular === null && (
        <button
          type="button"
          className={`mt-3 ${KNOPF}`}
          onClick={() => {
            setErfolg(null);
            setFormular('neu');
          }}
        >
          Neuer Alarmkanal
        </button>
      )}
      {formular !== null && (
        <KanalFormular
          key={formular === 'neu' ? 'neu' : formular.id}
          kanal={formular === 'neu' ? null : formular}
          onFertig={(t) => {
            setFormular(null);
            setErfolg(t);
          }}
          onAbbrechen={() => setFormular(null)}
        />
      )}
    </Abschnitt>
  );
}
