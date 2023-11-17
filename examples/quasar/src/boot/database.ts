import { boot } from 'quasar/wrappers';
import { createDatabase } from 'src/composables/database';

export default boot(async ({ store }) => {
  await createDatabase(store);
});
