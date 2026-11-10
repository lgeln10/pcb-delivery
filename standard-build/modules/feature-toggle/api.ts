// modules/feature-toggle/api.ts — 模块对外表面(其它模块/组合根只从这里引用)。
export { listDisabledKeys, setToggle, isProtectedKey, PROTECTED_KEYS } from './logic'
export { featureToggleRoutes } from './routes'
export { FEATURE_TOGGLE_PERMISSIONS } from './permissions'
export { FeatureToggleError, type FeatureToggleErrorCode } from './errors'
export { featureToggles, type FeatureToggle } from './model'
