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

## Run locally

From this directory, serve the built app:

```sh
python3 -m http.server 8000 --bind 0.0.0.0 --directory dist
```

Open `http://localhost:8000`, or use this device's LAN address and port 8000 from another device on the same network.

## GitHub Pages

Live site: [Microcontrollers Canvas](https://osaka-research.github.io/microcontrollers-canvas/).

Pushes to `main` publish the `dist/` directory through the workflow in `.github/workflows/pages.yml`.
