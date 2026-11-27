# MCC — Microcontrollers Canvas

A browser based canvas for connecting real microcontroller pins to recognizable components and exploring simple digital behavior. It is designed to explain physical connections in plain language.

## Components

- **Virtual Microcontroller** has four simulated digital outputs. It is not a specific physical board.
- **NodeMCU DevKit v1.0 (ESP-12E)** shows both 15-pin headers: D0–D8, RX/TX, A0, VIN, EN, RST, duplicate 3V3/GND, and the six SD/flash pads (visible but reserved). Each usable pad is a wire endpoint. GPIO uses 3.3 V logic; it is not 5 V tolerant and cannot directly power motors or servos. See the [open hardware design and pin map](https://github.com/nodemcu/nodemcu-devkit-v1.0).
- **TowerPro SG90 analog servo** shows SIGNAL (orange), V+ (red), and GND (brown/black). Its rated supply is 4.8 V; connect controller and servo grounds together. The canvas does not decode the servo's timed control pulses or model its current draw.
- **Battery packs** include Panasonic eneloop 2×AA (2.4 V), eneloop 4×AA (4.8 V), eneloop pro 4×AA (4.8 V, at least 2450 mAh), Energizer MAX E91 4×AA alkaline (6.0 V), and the Energizer 522 rectangular 9 V alkaline battery (PP3) with positive and negative snap terminals. Series packs add cell voltages; their mAh capacity does not multiply. Alkaline capacity varies with load. The 9 V block is intended for low-drain devices and is a poor choice for motors or servos. Do not connect any pack directly to NodeMCU 3V3.
- **Kingbright WP7113ID red LED** has ANODE (+) and CATHODE (−). Use a series current limiting resistor; 220 Ω is a common starting value for a 3.3 V output at about 10 mA.
- **Pololu #1101 6 V gearmotor** has M+ and M− terminals. Use an H-bridge motor driver and a suitable 6 V supply; its approximately 1.6 A stall current is far beyond a microcontroller GPIO.
- **SparkFun TB6612FNG dual motor-driver breakout** exposes its control, logic-power, motor-power, ground, and two motor-output pairs. The model shows all 16 header contacts and models the digital H-bridge direction truth table (`STBY`, `PWMA`/`PWMB`, `AIN1`/`AIN2`, `BIN1`/`BIN2` → `AO1`/`AO2`, `BO1`/`BO2`); it does not simulate PWM duty cycle, motor current, or heat.
- **HC-SR04 ultrasonic module** has VCC, TRIG, ECHO, and GND. It uses 5 V and its ECHO can be 5 V, so protect 3.3 V controller inputs. The canvas models a simplified digital trigger/echo response and interactive target-distance readout, not real microsecond ultrasonic pulse timing.

Part ratings and connection notes are linked from each component inspector. The sources include [Energizer 522 9 V](https://data.energizer.com/pdfs/522.pdf), [SparkFun TB6612FNG hookup guide](https://learn.sparkfun.com/tutorials/tb6612fng-hookup-guide/board-overview), and [HC-SR04 reference sheet](https://cdn.sparkfun.com/datasheets/Sensors/Proximity/HCSR04.pdf?file=HCSR04.pdf). The project survey and prioritized catalog plan are in [COMPONENTS.md](COMPONENTS.md).

The canvas is a digital learning model. It shows logic-level behavior and selected component responses, but does not simulate voltage, current, heat, battery capacity, LED current, motor drivers, or servo PWM.

## AI circuit builder

The AI chat supports an OpenAI API key or ChatGPT plan sign-in. API keys stay in the current tab and are sent to the server over HTTPS for each request; the app does not save them. OpenAI API usage is billed separately from a ChatGPT plan.

ChatGPT plan sign-in is available in the local MCC app only. Install dependencies, build the bundled `@siwc/local` runtime, then run `npm start` and open `http://127.0.0.1:4173`. Credentials are encrypted with the Android Keystore and stored under `~/.config/mcc/chatgpt`. This integration uses OpenAI's Sign in with ChatGPT DevKit, distributed under its Noncommercial License; see `vendor/siwc-local/LICENSE`.

The GitHub Pages app keeps the API-key option. Hosted ChatGPT plan use is disabled until OpenAI approves remote use. Request access with the [Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/), then provide the approved OAuth configuration and server-side protected token storage. The server searches relevant manufacturer references when the selected model and account allow web search; the app validates each build plan against its component and pin rules before applying it.

The AI endpoint is `api/build.js`, deployed as a Vercel function with the static site in `dist/`. Deploy this repository to Vercel with the output directory set to `dist`; the function is available at `/api/build`. The GitHub Pages workflow serves static files only and cannot run this endpoint. To keep using GitHub Pages, set `window.CANVAS_AI_ENDPOINT` in `dist/ai-config.js` to the deployed server's HTTPS `/api/build` URL and set `CANVAS_ORIGIN` in the server deployment to `https://osaka-research.github.io`. If you use a custom Vercel domain, set `CANVAS_ORIGIN` to the exact site origin.

## Database-backed component catalog

The browser does not bundle component definitions. It loads published records from `/api/components`; the server reads Supabase Postgres using `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. Component images can use Supabase Storage paths in `assetPath`. Keep the secret key in the Vercel server environment only. The database migration is `supabase/migrations/20261126_component_catalog.sql`.

To initialize a project, apply the migration in Supabase SQL Editor, then run `node scripts/seed-component-catalog.mjs` with `SUPABASE_URL` and a rotated Supabase secret key set in the local environment. The source records for this one-time seed are kept under `scripts/`; they are not loaded by the browser. Add and edit parts as records in `component_catalog`, and publish by setting `status` to `published`.

When a user asks for a part missing from the catalog, `/api/build` searches the web, checks manufacturer references and image results, creates a generic part record with a pin map and source links, saves it to Postgres, and includes it in the current build. Later users load the saved record. New parts use the same generic image and pin layout, so adding a normal component does not require a frontend code change. New interactive simulation behavior still requires a separately implemented model.

For images you have permission to redistribute, set `COMPONENT_IMAGE_ORIGIN` to their exact HTTPS origin to enable copying them into Storage. Other image sources are shown as reference links.

The migration also creates `project_templates` for public or private circuit templates and `user_projects` for per-user builds. The editor currently saves projects in browser storage. Account-backed save, reopen, and template selection still need application support.

The catalog endpoints require the Supabase database to be configured. The app includes no bundled production catalog fallback; if the database is unavailable, the component list stays empty and the server reports the configuration problem.

Cable and pass-through shield definitions can group named terminals that are permanently connected by copper. Each group carries signal, positive supply, or ground in either direction. A group can feed multiple inputs from one source. The simulation follows digital levels and wiring continuity. USB protocol signaling and electrical ratings require the product documentation.

### Local Adafruit staging catalog

Adafruit's product feed and product images can be staged on-device before a catalog server is configured. Run `node scripts/fetch-adafruit-products.mjs`, `node scripts/normalize-adafruit-products.mjs`, then `node scripts/import-adafruit-local-db.mjs`. The source feed, 5,597 product images, review records, and SQLite database stay under the ignored `.research/adafruit/` directory. `catalog.sqlite` has a `component_catalog` table matching the server columns and an `adafruit_products` table retaining the source feed rows. Candidate records stay in `draft`; pin layouts must be researched against exact product documentation before publication. Run `node scripts/export-adafruit-local-catalog.mjs` to create a JSON export in the server's `component_catalog` row shape for later migration. Product photos remain local research references until redistribution rights are confirmed.

Start the local canvas preview with `npm install`, `npm run build:siwc`, then `npm start`; open `http://127.0.0.1:4173`. It reads the local SQLite drafts and `.research/local-catalog.json`; the browser refreshes its component catalog every 15 seconds. The saved Adafruit Codex queue can be resumed with `python3 .research/adafruit/codex_product_queue.py`; newly completed, source-backed components appear in the canvas library automatically. The preview binds to localhost and does not upload catalog records or photos.

To research terminal names with OpenAI Luna, run `python3 scripts/research-adafruit-pins.py` after importing the local SQLite catalog. The default processes one pending component. Use `--limit 10` for a batch, `--product-id ID` for a specific draft, or `--all` to process the entire pending Adafruit queue, starting with component candidates. The script uses your signed-in Codex CLI and attaches the same image the preview serves. Luna checks the exact product documentation and returns an ordered list of terminal IDs, display names, and electrical roles. Complete layouts appear in the local preview with clickable terminal names in the component block. Uncertain layouts stay in manual review and can be retried by ID.


Search results are shown as source links. The canvas uses its own component drawings rather than embedding product photos with unknown redistribution rights. The AI can build with parts already in the component library; it explains when a requested part or supporting component is missing.

## Local verification

Install the test dependencies with `npm install --prefix .qa --no-save jsdom@26 @electric-sql/pglite@0.6.0`, then run `node --test tests/*.test.cjs`. The database test applies the migration to an embedded PostgreSQL instance and uses local fixtures for the Supabase HTTP and OpenAI responses.

## Run locally

For the full app, run the Vercel development server from this directory:

```sh
npx vercel dev
```

Open the local URL shown by Vercel. For a static-only host, configure the backend URL in `dist/ai-config.js` so the editor can load its catalog and send build requests.

## GitHub Pages

Live site: [MCC — Microcontrollers Canvas](https://osaka-research.github.io/microcontrollers-canvas/).

Pushes to `main` publish the `dist/` directory through the workflow in `.github/workflows/pages.yml`.
