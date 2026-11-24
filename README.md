# Microcontrollers Canvas

A browser based canvas for connecting real microcontroller pins to recognizable components and exploring simple digital behavior. It is designed to explain physical connections in plain language.

## Components

- **Virtual Microcontroller** has four simulated digital outputs. It is not a specific physical board.
- **NodeMCU ESP8266** shows D0–D8, RX, TX, 3V3, and GND. The chip uses 3.3 V logic; its GPIO pins cannot directly power motors or servos.
- **TowerPro SG90 analog servo** shows SIGNAL (orange), V+ (red), and GND (brown/black). Its rated supply is 4.8 V; connect controller and servo grounds together. The canvas does not decode the servo's timed control pulses or model its current draw.
- **Panasonic eneloop 4×AA NiMH pack** represents four 1.2 V cells in series (4.8 V nominal, at least 1900 mAh). Capacity does not multiply in a series pack. Do not connect 4.8 V directly to the NodeMCU 3V3 pin.
- **Kingbright WP7113ID red LED** has ANODE (+) and CATHODE (−). Use a series current limiting resistor; 220 Ω is a common starting value for a 3.3 V output at about 10 mA.
- **Pololu #1101 6 V gearmotor** has M+ and M− terminals. Use an H-bridge motor driver and a suitable 6 V supply; its approximately 1.6 A stall current is far beyond a microcontroller GPIO.

Part ratings and connection notes: [TowerPro SG90](https://towerpro.com.tw/product/sg90-analog/), [Panasonic eneloop](https://www.panasonic.com/global/energy/products/eneloop/en/lineup/eneloop.html), [Kingbright WP7113ID datasheet](https://www.kingbrightusa.com/images/catalog/SPEC/wp7113id.pdf), and [Pololu #1101](https://www.pololu.com/product/1101/).

The canvas is a digital learning model. It shows logic-level behavior and selected component responses, but does not simulate voltage, current, heat, battery capacity, LED current, motor drivers, or servo PWM.

## Run locally

From this directory, serve the built app:

```sh
python3 -m http.server 8000 --bind 0.0.0.0 --directory dist
```

Open `http://localhost:8000`, or use this device's LAN address and port 8000 from another device on the same network.

## GitHub Pages

Pushes to `main` publish the `dist/` directory through the workflow in `.github/workflows/pages.yml`.
