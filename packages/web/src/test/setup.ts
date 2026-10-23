// Testumgebung des Dashboards: nach jedem Test das DOM leeren (Vitest ohne globals).
// findBy/waitFor mit 3 s statt 1 s Frist: In der CI laufen alle Pakete parallel (Server gegen
// Postgres), dort reicht 1 s unter Last nicht immer.
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

configure({ asyncUtilTimeout: 3000 });

afterEach(() => {
  cleanup();
});
