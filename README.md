# Microcontrollers Canvas

A browser based canvas for connecting real microcontroller pins to recognizable components and exploring simple digital behavior. It is designed to explain physical connections in plain language.

## Components

- **Virtual Microcontroller** has four simulated digital outputs. It is not a specific physical board.
- **NodeMCU DevKit v1.0 (ESP-12E)** shows both 15-pin headers: D0–D8, RX/TX, A0, VIN, EN, RST, duplicate 3V3/GND, and the six SD/flash pads (visible but reserved). Each usable pad is a wire endpoint. GPIO uses 3.3 V logic; it is not 5 V tolerant and cannot directly power motors or servos. See the [open hardware design and pin map](https://github.com/nodemcu/nodemcu-devkit-v1.0).
- **TowerPro SG90 analog servo** shows SIGNAL (orange), V+ (red), and GND (brown/black). Its rated supply is 4.8 V; connect controller and servo grounds together. The canvas does not decode the servo's timed control pulses or model its current draw.
- **Battery packs** include Panasonic eneloop 2×AA (2.4 V), eneloop 4×AA (4.8 V), eneloop pro 4×AA (4.8 V, at least 2450 mAh), Energizer MAX E91 4×AA alkaline (6.0 V), and the Energizer 522 rectangular 9 V alkaline battery (PP3) with positive and negative snap terminals. Series packs add cell voltages; their mAh capacity does not multiply. Alkaline capacity varies with load. The 9 V block is intended for low-drain devices and is a poor choice for motors or servos. Do not connect any pack directly to NodeMCU 3V3.
- **Kingbright WP7113ID red LED** has ANODE (+) and CATHODE (−). Use a series current limiting resistor; 220 Ω is a common starting value for a 3.3 V output at about 10 mA.
- **Pololu #1101 6 V gearmotor** has M+ and M− terminals. Use an H-bridge motor driver and a suitable 6 V supply; its approximately 1.6 A stall current is far beyond a microcontroller GPIO.
- **SparkFun TB6612FNG dual motor-driver breakout** exposes its control, logic-power, motor-power, ground, and two motor-output pairs. The model shows all 16 header contacts; it does not simulate driver switching.
- **HC-SR04 ultrasonic module** has VCC, TRIG, ECHO, and GND. It uses 5 V and its ECHO can be 5 V, so protect 3.3 V controller inputs. The canvas does not calculate distance or pulse timing.

Part ratings and connection notes are linked from each component inspector. The sources include [Energizer 522 9 V](https://data.energizer.com/pdfs/522.pdf), [SparkFun TB6612FNG hookup guide](https://learn.sparkfun.com/tutorials/tb6612fng-hookup-guide/board-overview), and [HC-SR04 reference sheet](https://cdn.sparkfun.com/datasheets/Sensors/Proximity/HCSR04.pdf?file=HCSR04.pdf). The project survey and prioritized catalog plan are in [COMPONENTS.md](COMPONENTS.md).

The canvas is a digital learning model. It shows logic-level behavior and selected component responses, but does not simulate voltage, current, heat, battery capacity, LED current, motor drivers, or servo PWM.

## AI circuit builder

The canvas includes an AI chat panel. Enter an OpenAI API key, describe a project, and the server searches for relevant manufacturer references before returning a plan. The app validates every proposed component and connection against its library before adding it. The key is held in the current browser tab and sent to the server over HTTPS for each request; this project does not save it. OpenAI API usage is billed to the key's owner.

The AI endpoint is `api/build.js`, deployed as a Vercel function with the static site in `dist/`. Deploy this repository to Vercel with the output directory set to `dist`; the function is available at `/api/build`. The GitHub Pages workflow serves static files only and cannot run this endpoint. To keep using GitHub Pages, set `window.CANVAS_AI_ENDPOINT` in `dist/ai-config.js` to the deployed server's HTTPS `/api/build` URL and set `CANVAS_ORIGIN` in the server deployment to `https://osaka-research.github.io`. If you use a custom Vercel domain, set `CANVAS_ORIGIN` to the exact site origin.

Search results are shown as source links. The canvas uses its own component drawings rather than embedding product photos with unknown redistribution rights. The AI can build with parts already in the component library; it explains when a requested part or supporting component is missing.

## Run locally

For the full app, run the Vercel development server from this directory:

```sh
npx vercel dev
```

Open the local URL shown by Vercel. Serving `dist/` with a basic static HTTP server works for the canvas editor, but it does not provide the AI endpoint.

## GitHub Pages

Live site: [Microcontrollers Canvas](https://osaka-research.github.io/microcontrollers-canvas/).

Pushes to `main` publish the `dist/` directory through the workflow in `.github/workflows/pages.yml`.
