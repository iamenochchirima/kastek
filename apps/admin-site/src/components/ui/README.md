# Admin UI primitives

Use the primitives in this directory for new Admin screens before adding route-local control
styles. `Button`, `Input`, `Select`, `Textarea`, `Checkbox`, `Badge`, `Card`, and `Table` consume
the Admin Vantage tokens and density settings. Use `components/admin/data-toolbar.tsx` for list
filters and route actions.

Use `Dialog` for focused actions and confirmations, `Sheet` for responsive panels, and include a
`DialogTitle` plus `DialogDescription` in every modal. Use `FormField` when a field needs a hint or
inline error. Use `ChartCard` and the chart state components in `components/admin/chart.tsx` for
future data-backed analytics; pages must supply real data and an explicit empty or unavailable
state.
