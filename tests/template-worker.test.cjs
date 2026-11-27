const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('template worker validates RobotModel rules, retries on safety warnings, and saves locally', async t => {
  const worker = await import('../scripts/template-catalog-worker.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-tpl-test-'));
  const dbPath = path.join(tmpDir, 'catalog.sqlite');
  const jsonPath = path.join(tmpDir, 'local-templates.json');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  let calls = 0;
  const fakeGenerator = async prompt => {
    calls++;
    // First attempt deliberately uses a 9V battery on a motorDriver VM -> triggers safety warning & retry!
    if (calls === 1) {
      return {
        name: '2WD RC Car',
        description: 'RC car with bad battery.',
        realWorldNotes: 'Use NiMH pack.',
        components: [
          { type: 'esp8266', pack: '', modes: [], period: 1, distanceCm: 40, pinDirections: [] },
          { type: 'battery', pack: 'nineVolt', modes: [], period: 1, distanceCm: 40, pinDirections: [] },
          { type: 'motorDriver', pack: '', modes: [], period: 1, distanceCm: 40, pinDirections: [] },
          { type: 'motor', pack: '', modes: [], period: 1, distanceCm: 40, pinDirections: [] }
        ],
        wires: [
          { aComponent: 1, aPin: 0, bComponent: 2, bPin: 8 },
          { aComponent: 1, aPin: 0, bComponent: 2, bPin: 9 },
          { aComponent: 1, aPin: 1, bComponent: 2, bPin: 7 },
          { aComponent: 0, aPin: 0, bComponent: 2, bPin: 0 },
          { aComponent: 0, aPin: 1, bComponent: 2, bPin: 2 },
          { aComponent: 0, aPin: 2, bComponent: 2, bPin: 1 },
          { aComponent: 0, aPin: 3, bComponent: 2, bPin: 3 },
          { aComponent: 2, aPin: 11, bComponent: 3, bPin: 0 },
          { aComponent: 2, aPin: 12, bComponent: 3, bPin: 1 }
        ]
      };
    }
    // Second attempt receives the safety error in prompt and fixes battery to eneloop4!
    assert.match(prompt, /9 V PP3 battery on motor power/);
    return {
      name: '2WD RC Car (Dual Motor Drive)',
      description: 'Dual gearmotor RC car controlled via TB6612FNG H-bridge.',
      realWorldNotes: 'Real 2WD RC cars add a wireless receiver and separate logic/motor regulators.',
      components: [
        { type: 'esp8266', pack: '', modes: [], period: 1, distanceCm: 40, pinDirections: [] },
        { type: 'battery', pack: 'eneloop4', modes: [], period: 1, distanceCm: 40, pinDirections: [] },
        { type: 'motorDriver', pack: '', modes: [], period: 1, distanceCm: 40, pinDirections: [] },
        { type: 'motor', pack: '', modes: [], period: 1, distanceCm: 40, pinDirections: [] },
        { type: 'motor', pack: '', modes: [], period: 1, distanceCm: 40, pinDirections: [] }
      ],
      wires: [
        { aComponent: 1, aPin: 0, bComponent: 2, bPin: 8 },
        { aComponent: 1, aPin: 0, bComponent: 2, bPin: 9 },
        { aComponent: 1, aPin: 1, bComponent: 2, bPin: 7 },
        { aComponent: 0, aPin: 0, bComponent: 2, bPin: 0 },
        { aComponent: 0, aPin: 1, bComponent: 2, bPin: 2 },
        { aComponent: 0, aPin: 2, bComponent: 2, bPin: 1 },
        { aComponent: 0, aPin: 3, bComponent: 2, bPin: 3 },
        { aComponent: 0, aPin: 0, bComponent: 2, bPin: 6 },
        { aComponent: 0, aPin: 1, bComponent: 2, bPin: 4 },
        { aComponent: 0, aPin: 2, bComponent: 2, bPin: 5 },
        { aComponent: 2, aPin: 11, bComponent: 3, bPin: 0 },
        { aComponent: 2, aPin: 12, bComponent: 3, bPin: 1 },
        { aComponent: 2, aPin: 14, bComponent: 4, bPin: 0 },
        { aComponent: 2, aPin: 13, bComponent: 4, bPin: 1 }
      ]
    };
  };

  const result = await worker.runTemplateWorker({
    dbPath,
    jsonMirrorPath: jsonPath,
    templateId: 'rc-car-2wd',
    delayMs: 0,
    generator: fakeGenerator,
    log: () => {}
  });

  assert.equal(calls, 2);
  assert.equal(result.ready, 1);
  assert.equal(result.failed, 0);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stats = worker.getTemplateStats(db);
    assert.equal(stats.ready, 1);
    const saved = db.prepare("SELECT * FROM project_templates WHERE id = 'rc-car-2wd'").get();
    assert.equal(saved.status, 'ready');
    const project = JSON.parse(saved.project);
    assert.equal(project.nodes.length, 5);
    assert.equal(project.wires.length, 14);
    // Role-based layout puts MCU/battery on left (x=80), motorDriver mid (x=360), motors right (x=660)
    assert.equal(project.nodes[0].x, 80);
    assert.equal(project.nodes[2].x, 360);
    assert.equal(project.nodes[3].x, 660);
  } finally {
    db.close();
  }
  const mirror = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.equal(mirror.length, 1);
  assert.equal(mirror[0].id, 'rc-car-2wd');
});
