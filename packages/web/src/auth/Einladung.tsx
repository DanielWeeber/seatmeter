// Einladung annehmen (`/einladung/<token>`): ohne Anmeldung erreichbar. Der Link prüft das Token
// (`POST /auth/einladung/pruefen`), der Nutzer legt sein Passwort fest (`POST /auth/einladung`) und ist
// danach angemeldet. Das Token steht nur im Pfad und im Request-Körper, nie in Logs oder Meldungen.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { ApiFehler, useApi } from '../api/client';
import { authMeSchema } from '../api/typen';
import { Fehlermeldung, Laden } from '../komponenten/Abfrage';
import { Feld, knopf, Meldung, PASSWORT_MINDESTLAENGE, Rahmen } from './Formulare';

export const EINLADUNG_PFAD = /^\/einladung\/([^/]+)$/;

const TEXT_UNGUELTIG = 'Der Einladungslink ist ungültig, schon benutzt oder abgelaufen.';

const pruefSchema = z.object({ benutzername: z.string(), gueltig_bis: z.string().nullish() });

export function Einladung({ token }: { token: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [passwort, setPasswort] = useState('');
  const [wiederholung, setWiederholung] = useState('');
  const [pruefung, setPruefung] = useState<string | null>(null);

  const einladung = useQuery({
    queryKey: ['auth', 'einladung', 'pruefen'],
    retry: false,
    // Das Token gehört bewusst nicht in den Query-Schlüssel.
    queryFn: () => api.post('/api/v1/auth/einladung/pruefen', { token }, pruefSchema),
  });

  const annehmen = useMutation({
    mutationFn: async () => {
      const me = await api.post('/api/v1/auth/einladung', { token, passwort }, authMeSchema);
      api.merkeCsrf(me.csrf);
    },
    onSuccess: () => {
      void navigate('/', { replace: true });
      void queryClient.invalidateQueries({ queryKey: ['auth'] });
    },
  });

  const absenden = (e: FormEvent) => {
    e.preventDefault();
    if (passwort.length < PASSWORT_MINDESTLAENGE) {
      setPruefung(`Das Passwort braucht mindestens ${PASSWORT_MINDESTLAENGE} Zeichen.`);
      return;
    }
    if (passwort !== wiederholung) {
      setPruefung('Die Passwörter stimmen nicht überein.');
      return;
    }
    setPruefung(null);
    annehmen.mutate();
  };

  if (einladung.isPending) return <Laden text="Prüfe Einladung …" />;
  if (einladung.isError) {
    const fehler = einladung.error;
    if (fehler instanceof ApiFehler && fehler.art === 'http' && fehler.status === 404) {
      return (
        <Rahmen titel="Einladung">
          <Meldung text={TEXT_UNGUELTIG} />
          <a href="/" className="mt-4 block text-sm text-slate-600 underline">
            Zur Anmeldung
          </a>
        </Rahmen>
      );
    }
    return (
      <main className="mx-auto max-w-md p-8">
        <Fehlermeldung fehler={fehler} erneut={() => void einladung.refetch()} />
      </main>
    );
  }

  const fehlerText = annehmen.isError
    ? annehmen.error instanceof ApiFehler && annehmen.error.status === 404
      ? TEXT_UNGUELTIG
      : annehmen.error instanceof ApiFehler && annehmen.error.status === 429
        ? 'Zu viele Versuche. Bitte später erneut versuchen.'
        : 'Das Konto konnte nicht eingerichtet werden.'
    : null;

  return (
    <Rahmen titel={`Konto ${einladung.data.benutzername} einrichten`}>
      <p className="mt-2 text-sm text-slate-600">
        Lege ein Passwort für dein Konto fest. Danach bist du angemeldet.
      </p>
      <form onSubmit={absenden} noValidate>
        <Feld
          name="passwort"
          beschriftung="Passwort"
          typ="password"
          wert={passwort}
          onAendern={setPasswort}
          autocomplete="new-password"
          hilfe={`Mindestens ${PASSWORT_MINDESTLAENGE} Zeichen.`}
        />
        <Feld
          name="wiederholung"
          beschriftung="Passwort wiederholen"
          typ="password"
          wert={wiederholung}
          onAendern={setWiederholung}
          autocomplete="new-password"
        />
        <Meldung text={pruefung ?? fehlerText} />
        <button type="submit" className={knopf} disabled={annehmen.isPending}>
          {annehmen.isPending ? 'Richte ein …' : 'Konto einrichten'}
        </button>
      </form>
    </Rahmen>
  );
}
