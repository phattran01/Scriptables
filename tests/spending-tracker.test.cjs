const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'Manual-Spending-Tracker.js'), 'utf8');
const library = source.split('\nif (config.runsInWidget)')[0];

function setup() {
  const files = { local: new Map(), cloud: new Map() };
  const views = [];
  function fileManager(kind) {
    const map = files[kind];
    return {
      documentsDirectory: () => kind,
      joinPath: (dir, name) => dir + '/' + name,
      fileExists: file => map.has(file),
      readString: file => {
        if (!map.has(file)) throw new Error('Missing file: ' + file);
        return map.get(file);
      },
      writeString: (file, text) => map.set(file, text),
      downloadFileFromiCloud: async () => {},
      move: (from, to) => {
        if (map.has(to)) throw new Error('Destination already exists');
        map.set(to, map.get(from)); map.delete(from);
      }
    };
  }
  class WebView {
    constructor() { this.loads = []; views.push(this); }
    async loadHTML(html) { this.loads.push(html); }
    present() { return new Promise(resolve => { this.dismiss = resolve; }); }
  }
  const context = {
    FileManager: { local: () => fileManager('local'), iCloud: () => fileManager('cloud') },
    WebView,
    DocumentPicker: { exportString: async () => {} },
    console
  };
  vm.createContext(context);
  vm.runInContext(library, context);
  return { context, files, views };
}

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for WebView reload');
}

test('WebView actions save expenses and budgets and reject invalid amounts', async () => {
  const { context, files, views } = setup();
  const existing = { id: 'existing', amount: 25.12, note: 'panda',
    category: 'Food & Drinks', date: '2026-11-15T12:00:00.000Z' };
  files.cloud.set('cloud/spending-tracker.json', JSON.stringify([existing]));
  context.state = { expenses: [existing], budget: 0 };
  const running = vm.runInContext('showApp(state, false)', context);
  await waitFor(() => views[0]?.loads.length === 1);
  const web = views[0];
  assert.match(web.loads[0], /scriptable-action\.invalid/);

  async function send(action, expectedStatus) {
    const before = web.loads.length;
    const url = 'https://scriptable-action.invalid/submit?payload=' +
      encodeURIComponent(JSON.stringify(action));
    assert.equal(web.shouldAllowRequest({ url }), false);
    await waitFor(() => web.loads.length === before + 1);
    assert.ok(web.loads.at(-1).includes(expectedStatus));
  }

  await send({ type: 'save', id: null, amount: '14.50', note: 'Lunch',
    category: 'Food & Drinks', date: '2026-11-15' }, 'Expense saved');
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker.json'))[1].amount, 14.5);
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker-backup.json')).length, 1);

  await send({ type: 'budget', amount: '1200.00' }, 'Monthly target saved');
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker-settings.json')).monthlyBudget, 1200);

  await send({ type: 'save', id: null, amount: 'bad', note: 'Nope',
    category: 'Food & Drinks', date: '2026-11-15' }, 'Enter dollars');
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker.json')).length, 2);

  web.dismiss();
  await running;
});

test('embedded WebView JavaScript parses', () => {
  const { context } = setup();
  const html = vm.runInContext('makeHTML({expenses:[],budget:0}, false)', context);
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match);
  new vm.Script(match[1]);
});
