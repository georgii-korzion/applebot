// Точка входа сборки `node build.mjs --hub` → hub/lib/shared.mjs: хаб валидирует fleet.json тем же кодом,
// что и расширение (FLEET-SPEC §9.2). Файл в hub/lib/ генерируется, править нужно src/shared/*.
export {
  DEFAULT_TIMING, STRATEGIES, defaultConfig, defaultOrder, normalizeConfig, normalizeOrder, normalizeProxy,
  orderFor, serverOf, validateConfig, configUrlFromHub, parseIdentityHash,
} from './config';
export type { Config, OrderCfg, ProxyCfg, Strategy, Timing, Validation } from './config';
export { PARTS, STORES, normPart, partLabel, storeName } from './parts';
export { waitPlan } from './strategy';
