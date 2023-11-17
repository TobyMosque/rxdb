import { Pinia } from 'pinia';
import { RxError } from 'rxdb';
import { createDatabase as baseCreate, Database } from 'src/database';
import { useDiStore } from 'src/stores/di';

declare module 'pinia' {
  export interface PiniaCustomProperties {
    readonly database: Database;
  }
}

export async function createDatabase(pinia: Pinia) {
  const database = await baseCreate();
  pinia.use(() => ({
    database
  }));
}

export function useDatabase(pinia?: Pinia) {
  console.log('useDatabase')
  const di = useDiStore(pinia);
  return di.database;
}

export function getValidationErrors(err: unknown) {
  if (err && typeof err === 'object' && 'parameters' in err) {
    const rxError = err as never as RxError
    if (rxError.parameters.writeError && 'validationErrors' in rxError.parameters.writeError) {
      return rxError.parameters.writeError.validationErrors
    }
  }
  return []
}