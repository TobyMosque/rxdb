import { Pinia } from 'pinia';
import { useDiStore } from 'src/stores/di';

import type { HeroesService } from '../../src-ssr/api/heroes';
import type { FeathersApp } from '../../src-ssr/api/index';
import type { FeathersService } from '@feathersjs/feathers/lib';

declare module 'pinia' {
  export interface PiniaCustomProperties {
    readonly getApi: () => FeathersApp;
    readonly getHeroesApi: () => FeathersService<FeathersApp, HeroesService>;
  }
}

export async function createApi(pinia: Pinia, api: FeathersApp) {
  const heroesApi = api.service('api/heroes');
  // api and heroesApi can't be injected directly in the store...
  pinia.use(() => ({
    getApi: () => api, 
    getHeroesApi: () => heroesApi
  }));
}

export function useApi(pinia?: Pinia) {
  const di = useDiStore(pinia);
  return di.getApi();
}

export function useHeroesApi(pinia?: Pinia) {
  const di = useDiStore(pinia);
  return di.getHeroesApi();
}