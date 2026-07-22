# React UI

## Component design

- Define the smallest reusable component that still captures the pattern.
- Prefer controlled props for visible behavior and callbacks for interaction.
- Keep variants explicit instead of encoding them in ad hoc booleans.
- Pass layout concerns through composition when possible.

## Implementation heuristics

- Build a simple hierarchy: page -> section -> component -> primitive.
- Keep state local unless multiple siblings need it.
- Make responsive decisions explicit for breakpoints, spacing, and stacking.
- Align to the repository's existing CSS approach, design tokens, and component conventions.
- Add accessibility defaults for labels, focus, keyboard use, and semantic structure.

## Common failure modes

- One oversized component that mixes layout, data fetching, and rendering.
- Props that only work for one screen.
- Responsive rules hidden in deeply nested CSS.
- UI copied from a mockup without reusable structure.
