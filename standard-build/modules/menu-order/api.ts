// modules/menu-order/api.ts — 模块对外表面(其它模块/组合根只从这里引用)。
export { getMenuOrder, saveMenuOrder, normalizeMenuOrder, type MenuOrder } from './logic'
export { menuOrderRoutes } from './routes'
export { MENU_ORDER_PERMISSIONS } from './permissions'
export { MenuOrderError, type MenuOrderErrorCode } from './errors'
export { menuOrders, type MenuOrderRow } from './model'
