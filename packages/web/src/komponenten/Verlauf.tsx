// Tagesverlauf eines Projekts: eine Reihe (Tokens je Tag), gedeckte Farbe, deutsche Achsen und Tooltip.
// Wird per lazy() geladen, damit Recharts nicht im Startbündel landet.
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TagZeile } from '../api/typen';
import { datum, usdAusMikro, zahl } from '../format';

/** Flache Reihe für Recharts aus den Tageszeilen der API. */
interface VerlaufsTag {
  tag: string;
  anfragen: number;
  tokens_gesamt: number;
  schatten_usd_micros: number;
}

const kompakt = new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 });
const FARBE = '#475569'; // slate-600: eine Reihe, keine Signalfarbe

function tagKurz(tag: string): string {
  const [, monat, t] = tag.split('-');
  return `${t}.${monat}.`;
}

function Hinweisfeld({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
}) {
  const eintrag = payload?.[0]?.payload as VerlaufsTag | undefined;
  if (!active || !eintrag) return null;
  return (
    <div className="rounded border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm">
      <p className="font-medium">{datum(eintrag.tag)}</p>
      <p className="tabular-nums">{zahl(eintrag.tokens_gesamt)} Tokens</p>
      <p className="tabular-nums text-slate-600">{zahl(eintrag.anfragen)} Anfragen</p>
      <p className="tabular-nums text-slate-600">
        {usdAusMikro(eintrag.schatten_usd_micros)} Schattenpreis
      </p>
    </div>
  );
}

export default function Verlauf({ tage }: { tage: TagZeile[] }) {
  const daten: VerlaufsTag[] = tage.map((t) => ({
    tag: t.tag,
    anfragen: t.anfragen,
    tokens_gesamt: t.tokens.gesamt,
    schatten_usd_micros: t.schatten_usd_micros,
  }));
  return (
    <figure>
      <figcaption className="mb-2 text-sm text-slate-600">Tokens je Tag</figcaption>
      <div className="h-56 w-full rounded border border-slate-200 bg-white p-2">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 600, height: 208 }}
        >
          <AreaChart data={daten} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="tag"
              tickFormatter={tagKurz}
              tick={{ fill: '#64748b', fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: '#cbd5e1' }}
              minTickGap={16}
            />
            <YAxis
              tickFormatter={(w: number) => kompakt.format(w)}
              tick={{ fill: '#64748b', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={56}
              label={{
                value: 'Tokens',
                angle: -90,
                position: 'insideLeft',
                fill: '#64748b',
                fontSize: 12,
              }}
            />
            <Tooltip content={Hinweisfeld} cursor={{ stroke: '#94a3b8', strokeWidth: 1 }} />
            <Area
              type="monotone"
              dataKey="tokens_gesamt"
              name="Tokens"
              stroke={FARBE}
              strokeWidth={2}
              fill={FARBE}
              fillOpacity={0.12}
              activeDot={{ r: 4, stroke: '#ffffff', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
