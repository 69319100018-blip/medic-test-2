# Dashboard Page Override

This page inherits `../MASTER.md` and applies these dashboard-specific rules.

- Platform: desktop-first responsive web dashboard, with 375px, 768px, 1024px, and 1440px verification widths.
- Default theme: dark on every dashboard visit. The existing Numpad 9 shortcut toggles dark/light; keep this behavior unchanged.
- Thai UI typography: use Noto Sans Thai for headings, body copy, labels, and form controls. This overrides the generic Fira pairing because the product is Thai-first; retain tabular numerals for operational values where existing components support them.
- Surfaces: layered navy/slate panels with restrained translucent topbar treatment. Avoid large blurred glass surfaces behind dense data.
- Text: primary copy #F8FAFC; secondary copy #C2D0DF; placeholders #A8BBCE. Never use low-contrast gray on gray.
- Accents: cyan for navigation/focus, green for success/primary positive actions, amber for pending/warning, rose for destructive/rejected states.
- Inputs: dark inset surface, visible border, clear placeholder, and a visible keyboard focus ring.
- Interaction: 160–220ms transitions, visible hover/focus/disabled states, and respect `prefers-reduced-motion`.
- Preserve existing routes, IDs, permissions, data behavior, and all dashboard workflows while styling.
