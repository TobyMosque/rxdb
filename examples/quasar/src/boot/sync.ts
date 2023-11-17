import { boot } from 'quasar/wrappers';
import { syncHeroes } from 'src/database';
import { useDatabase } from 'src/composables/database';
import { useHeroesApi } from 'src/composables/api';

export default boot(async ({ store }) => {
  const heroesApi = useHeroesApi(store);
  const database = useDatabase(store);

  syncHeroes(database, heroesApi);
});
