// SDK stub for SSR render test
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const STATUSBAR_AREAS = { left: 'status-left', right: 'status-right' }
export const PALETTE_AREA = 'palette'
export const host = {
  navigate: () => {},
  request: () => Promise.resolve(null),
  state: { focusedUsage: null, focusedSessionId: null },
}
export const useValue = () => null

export const usePluginI18n = () => ((k) => k)
