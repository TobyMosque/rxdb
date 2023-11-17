import { Pinia } from 'pinia';
import { createDatabase as baseCreate, Database } from 'src/database';
import { useDiStore } from 'src/stores/di';

declare module 'pinia' {
  export interface PiniaCustomProperties {
    readonly database: Database;
  }
}

export async function createDatabase(pinia: Pinia) {
  const database = await baseCreate();
  pinia.use(() => ({ database }));
}

export function useDatabase(pinia?: Pinia) {
  const di = useDiStore(pinia);
  return di.database;
}