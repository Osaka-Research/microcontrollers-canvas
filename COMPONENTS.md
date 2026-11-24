# Robotics parts survey and catalog plan

This is a working survey of recurring parts found across beginner mobile robot builds, line followers, and a small sample of ROS mobile robot bills of materials. It is a practical sample, not a claim that every robotics project uses the same kit.

## Patterns seen in the project sample

| Parts that recur | Why they appear | Catalog state |
| --- | --- | --- |
| Microcontroller board | Reads sensors and commands motors | NodeMCU ESP8266 pinout; virtual four-output controller |
| Two DC gearmotors, wheels, chassis, caster | Common differential-drive base | One illustrative gearmotor; mechanical chassis and wheel set still needed |
| Dual H-bridge motor driver | Lets low-current GPIO signals control motor current and direction | TB6612FNG breakout pins added; switching behavior remains unmodeled |
| Battery pack, holder, power regulation | Separates motor power from logic power | AA packs and 9 V PP3 added; 18650 pack and buck/boost converters still needed |
| Ultrasonic distance sensor | Basic obstacle detection | HC-SR04 four-pin layout added; distance reading remains unmodeled |
| Servo | Pans a sensor or moves a small mechanism | TowerPro SG90, three physical connections |
| IR reflectance sensor or array | Detects a line or floor edge | Next electronics addition |
| Wheel encoder | Measures wheel rotation for speed and odometry | Next electronics addition |
| IMU and LiDAR | Orientation and mapping on more advanced mobile robots | Advanced tier, later addition |
| Breadboard, switch, jumper wires | Prototyping and power isolation | Needed as teaching/assembly items; not yet modeled |

## Sampled project references

- [Geekobot obstacle-avoiding robot parts list](https://geekobot.in/in/projects/obstacle-avoiding-robot) lists an Uno, L298N, HC-SR04, SG90, 2WD chassis, two 18650 cells and holder, boost converter, and breadboard.
- [Cirkit Designer obstacle-avoiding robot](https://docs.cirkitdesigner.com/project/published/32d26e14-0a74-4f81-b054-6bbaf4f124d4/arduino-uno-based-obstacle-avoiding-robot-with-ultrasonic-sensor-and-servo-motor) shows the common Uno + ultrasonic + servo + dual-motor-driver wiring pattern and shared ground.
- [Pololu 3pi robot guide](https://www.pololu.com/docs/0j21/all) covers a compact differential-drive robot with two motors, reflectance sensors, batteries, and motor control.
- [Pololu 3pi+ 2040 controller schematic](https://www.pololu.com/file/0J1940/3pi-2040-control-board-schematic.pdf) includes motor drivers and Hall-effect wheel encoders.
- [Arduino line-following robot project sheet](https://cdnbbs.s3waas.gov.in/s3kv0172cc68f8c6297abfb8c3c9e575b8/uploads/2025/10/2025100333.pdf) uses IR sensors, a motor driver, motors, controller, and battery.
- [SparkFun TB6612FNG hookup guide](https://learn.sparkfun.com/tutorials/tb6612fng-hookup-guide/board-overview) documents a common dual H-bridge breakout and its control, supply, and motor pins.
- [DPRG ROS/SLAM minibot bill of materials](https://www.dprg.org/wp-content/uploads/2025/03/ROS-SLAM-Linorobot.pdf) shows the advanced tier: encoder gearmotors, robot controller, battery, IMU/LiDAR-class sensing, and mapping hardware.
- [HC-SR04 reference sheet](https://cdn.sparkfun.com/datasheets/Sensors/Proximity/HCSR04.pdf?file=HCSR04.pdf) lists VCC, TRIG, ECHO, and GND.

## Add next

1. A 2WD chassis set with two wheels and a caster as mechanical parts, with dimensions/mounting explained rather than fake signal pins.
2. A 5-channel reflectance array such as Pololu QTR-5RC, including every sensor output, LED control, VCC, and GND.
3. A wheel encoder gearmotor example, with A/B quadrature output pins per motor and an explanation that pulse counts measure wheel rotation.
4. A 2-cell 18650 holder and a matched, protected pack example. State cell chemistry, nominal and full-charge voltage, protection/charging requirements, and the limits of series capacity.
5. A regulated buck converter module with input/output pins and an adjustable voltage warning.
6. A small tactile bumper switch, then a common I2C IMU and an entry-level 2D LiDAR for the advanced tier.

For each item, verify an exact market example and current pin/rating details from a manufacturer datasheet before exposing it in the catalog. Explain its real function in beginner language and mark which behavior the canvas does not simulate.
