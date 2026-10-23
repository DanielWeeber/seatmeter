// Schwellen der Hinweis-Regeln: für alle lesbar, für Admins änderbar (PUT /api/v1/hinweise/regeln,
// immer alle fünf Felder: zod 4 füllt bei `partial()` fehlende Felder mit den Standardwerten auf)
// und neu berechenbar (POST /api/v1/jobs/hinweise/erzeugen).
import { hinweisRegelnSchema, type HinweisRegeln } from '@seatmeter/shared';
import { useApi } from '../../api/client';
import { useAuth } from '../../auth/AuthTor';
import { alsEingabe, alsZahl, dezimalzahl } from '../../format';
import { Werte } from '../../komponenten/Bausteine';
import { Eingabe, Formular } from '../../komponenten/Formular';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { KNOPF } from '../../komponenten/knoepfe';
import { speicherFehler } from '../../komponenten/Zugriff';
import { REGEL_FELDER, REGEL_TEXT } from './texte';

/** Antwort von POST /api/v1/jobs/hinweise/erzeugen. */
const erzeugenSchema = z.object({ hinweise: z.number() });

export function NeuBerechnen({ monat }: { monat: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const erzeugen = useMutation({
    mutationFn: () =>
      api.post(
        `/api/v1/jobs/hinweise/erzeugen?monat=${encodeURIComponent(monat)}`,
        undefined,
        erzeugenSchema,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['hinweise'] }),
  });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        className={KNOPF}
        disabled={erzeugen.isPending}
        onClick={() => erzeugen.mutate()}
      >
        {erzeugen.isPending ? 'Berechne …' : 'Jetzt neu berechnen'}
      </button>
      {erzeugen.isSuccess && (
        <span role="status" className="text-sm text-green-800">
          Neu berechnet: {erzeugen.data.hinweise} Hinweise.
        </span>
      )}
      {erzeugen.isError && (
        <span role="alert" className="text-sm text-red-800">
          {speicherFehler(erzeugen.error)}
        </span>
      )}
    </div>
  );
}

function RegelnFormular({ regeln }: { regeln: HinweisRegeln }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [f, setF] = useState<Record<keyof HinweisRegeln, string>>(() => {
    const aus = {} as Record<keyof HinweisRegeln, string>;
    for (const feld of REGEL_FELDER) aus[feld] = alsEingabe(regeln[feld]);
    return aus;
  });
  const [feldFehler, setFeldFehler] = useState<Partial<Record<keyof HinweisRegeln, string>>>({});
  const [meldung, setMeldung] = useState<string | null>(null);
  const [erfolg, setErfolg] = useState<string | null>(null);

  const speichern = useMutation({
    mutationFn: (koerper: HinweisRegeln) =>
      api.put('/api/v1/hinweise/regeln', koerper, hinweisRegelnSchema),
    onSuccess: async () => {
      setErfolg('Gespeichert. „Jetzt neu berechnen“ wendet die neuen Schwellen an.');
      await queryClient.invalidateQueries({ queryKey: ['hinweise'] });
    },
    onError: (fehler) => setMeldung(speicherFehler(fehler)),
  });

  const absenden = () => {
    setErfolg(null);
    setMeldung(null);
    const werte = Object.fromEntries(REGEL_FELDER.map((feld) => [feld, alsZahl(f[feld])]));
    // Wertebereiche prüft der Vertrag (z. B. 1 bis 100 Prozent); NaN fällt dabei durch.
    const geprueft = hinweisRegelnSchema.safeParse(werte);
    if (!geprueft.success) {
      const je: Partial<Record<keyof HinweisRegeln, string>> = {};
      for (const issue of geprueft.error.issues) {
        const feld = issue.path[0] as keyof HinweisRegeln | undefined;
        if (feld && !je[feld]) je[feld] = 'Bitte eine Zahl im erlaubten Bereich angeben.';
      }
      setFeldFehler(je);
      setMeldung('Bitte die markierten Felder prüfen.');
      return;
    }
    setFeldFehler({});
    if (REGEL_FELDER.every((feld) => geprueft.data[feld] === regeln[feld])) {
      setErfolg('Keine Änderung.');
      return;
    }
    speichern.mutate(geprueft.data);
  };

  return (
    <Formular
      titel="Schwellen ändern"
      onAbsenden={absenden}
      laeuft={speichern.isPending}
      meldung={meldung}
      erfolg={erfolg}
    >
      {REGEL_FELDER.map((feld) => (
        <Eingabe
          key={feld}
          beschriftung={REGEL_TEXT[feld]}
          wert={f[feld]}
          dezimal
          onAendern={(w) => {
            setF((alt) => ({ ...alt, [feld]: w }));
            setErfolg(null);
          }}
          fehler={feldFehler[feld]}
        />
      ))}
    </Formular>
  );
}

export function Regeln({ regeln }: { regeln: HinweisRegeln }) {
  const { darfVerwalten } = useAuth();
  if (darfVerwalten) return <RegelnFormular regeln={regeln} />;
  return (
    <Werte eintraege={REGEL_FELDER.map((feld) => [REGEL_TEXT[feld], dezimalzahl(regeln[feld])])} />
  );
}
