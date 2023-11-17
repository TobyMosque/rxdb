import { boot } from 'quasar/wrappers';
import { feathers } from '@feathersjs/feathers';
import rest from '@feathersjs/rest-client';
import axios from 'axios';
import { createApi } from 'src/composables/api';
import type { ServiceTypes } from '../../../src-ssr/api';

export default boot(async ({ store }) => {
  const apiClient = axios.create({ baseURL: '/' });
  const restClient = rest();
  const services = restClient.axios(apiClient);

  const api = feathers<ServiceTypes>();
  api.configure(services);

  createApi(store, api);
});
