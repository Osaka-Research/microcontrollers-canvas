# Microcontrollers Canvas

A browser based canvas for connecting microcontroller pins to components and simulating simple digital behavior.

## Components

- **Microcontroller** is a virtual controller with four digital outputs.
- **NodeMCU ESP8266** exposes D0–D8, RX, TX, 3V3, and GND.
- **Servo** has separate SIGNAL, V+, and GND terminals.
- **Battery pack** provides positive and ground terminals for matching power connections.
- LEDs and DC motors respond to a connected digital signal.

The canvas is a learning model. It does not simulate electrical voltage, current draw, battery capacity, or servo PWM. For real wiring, use a servo rated supply and connect the supply ground to the controller ground.

## Run locally

From this directory, serve the built app:

```sh
python3 -m http.server 8000 --bind 0.0.0.0 --directory dist
```

Open `http://localhost:8000`, or use this device's LAN address and port 8000 from another device on the same network.

## GitHub Pages

Pushes to `main` publish the `dist/` directory through the workflow in `.github/workflows/pages.yml`.
