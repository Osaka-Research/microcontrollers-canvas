# Component accuracy and teaching standards

This project teaches beginners to connect real electronics. New or changed components must be recognizable as real market parts and must explain their real connections in plain language.

## Before adding or changing a component

- Choose a specific, commonly available part or clearly label the component as a virtual abstraction. Prefer a manufacturer part number over a generic label.
- Verify its electrical and mechanical details against a current manufacturer datasheet or product page. Record the source URL in the component inspector or project documentation.
- Show every physical terminal the user would wire. Examples: a servo has signal, supply, and ground; an LED has anode and cathode; a DC motor has two motor terminals; a battery has positive and negative terminals; a development board exposes its labeled header pins.
- Label terminals as they appear on the real part, and add wire color or polarity where that helps a beginner.
- Enforce compatible connections in `dist/model.js`: signal to signal, positive supply to a power input, and ground to ground. Update wire drawing and hit targets in `dist/app.js` and `dist/wiring.js` when pin identifiers or counts change.
- Explain required supporting parts and safe power arrangements. For example, identify LED current limiting, motor drivers, servo current needs, shared grounds, and voltage limits when relevant. Do not imply that a GPIO can directly supply a high-current load.
- Give the component inspector a short, beginner-friendly description, useful operating values, and practical wiring steps. Define unfamiliar terms in context.
- State simulation limits clearly. A digital high/low animation is not electrical simulation; do not imply it calculates voltage, current, heat, battery capacity, PWM, or load behavior unless that behavior is actually modeled.
- Keep instructional copy direct and readable for nontechnical users. Prefer concrete labels and a short step-by-step wiring explanation over unexplained abbreviations.

## Files to update

- `dist/model.js`: component identity, pin definitions, pin kinds, connection compatibility, and behavior.
- `dist/app.js`: component rendering, labels, inspector content, and signal display.
- `dist/wiring.js`: only when wiring gestures or endpoint handling need changes.
- `dist/style.css`: pin appearance and readable layouts.
- `dist/index.html`: library entry, accessible label, and versioned asset references.
- `README.md`: add or revise the user-facing component and simulation notes when the new part changes the project overview.

If any market specification is uncertain, research it before writing it into the interface. Do not invent ratings or treat one variant's specifications as universal for a product family.
