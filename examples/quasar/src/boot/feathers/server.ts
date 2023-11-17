import { boot } from 'quasar/wrappers';
import { feathers } from '@feathersjs/feathers';
import { createApi } from 'src/composables/api';
import { setup } from '../../../src-ssr/api/heroes';
import type { ServiceTypes } from '../../../src-ssr/api/index';

export default boot(async ({ store }) => {
  const api = feathers<ServiceTypes>();
  api.configure(setup);

  createApi(store, api);
});
