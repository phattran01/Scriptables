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

  const added = JSON.parse(files.cloud.get('cloud/spending-tracker.json'))[1];
  await send({ type: 'delete', id: added.id }, 'Expense deleted');
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker.json')).length, 1);

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

test('delete button opens in-page confirmation and submits the selected expense', () => {
  const { context } = setup();
  context.state = { expenses: [{ id: 'old', amount: 25.12, note: 'panda',
    category: 'Food & Drinks', date: new Date().toISOString() }], budget: 0 };
  const html = vm.runInContext('makeHTML(state, false)', context);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  class Element {
    constructor() {
      this.children = [];
      this.style = {};
      this.value = '';
      this.classList = {
        add: name => { this.classes.add(name); },
        remove: name => { this.classes.delete(name); },
        contains: name => this.classes.has(name),
        toggle: (name, force) => { if (force) this.classes.add(name); else this.classes.delete(name); }
      };
      this.classes = new Set();
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    focus() {}
  }
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get('progress').firstElementChild = new Element();
  const nav = ['overview', 'history', 'settings'].map(tab => {
    const button = new Element(); button.dataset = { tab }; return button;
  });
  const page = {
    document: {
      getElementById: get,
      createElement: () => new Element(),
      querySelectorAll: () => nav
    },
    window: { location: { href: '' } },
    setTimeout: () => 1,
    clearTimeout: () => {}
  };
  vm.createContext(page);
  vm.runInContext(script, page);
  get('recent').children[0].onclick();
  get('deleteExpense').onclick();
  assert.equal(get('deleteDialog').classList.contains('open'), true);
  assert.match(get('deleteMessage').textContent, /panda/);
  get('confirmDelete').onclick();
  const payload = decodeURIComponent(page.window.location.href.split('payload=')[1]);
  assert.equal(JSON.parse(payload).type, 'delete');
  assert.equal(JSON.parse(payload).id, 'old');
});

test('widget families show progressively more detail', () => {
  const { context } = setup();
  class WidgetNode {
    constructor() { this.children = []; }
    addText(value) { const child = { text: String(value), centerAlignText() {} }; this.children.push(child); return child; }
    addStack() { const child = new WidgetNode(); this.children.push(child); return child; }
    addImage(image) { const child = { image }; this.children.push(child); return child; }
    addSpacer() { this.children.push({ spacer: true }); }
    setPadding() {}
    layoutHorizontally() {}
    layoutVertically() {}
    centerAlignContent() {}
  }
  context.ListWidget = WidgetNode;
  context.Color = class Color { constructor(value) { this.value = value; } };
  context.Size = class Size { constructor(width, height) { Object.assign(this, { width, height }); } };
  context.Rect = class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } };
  context.DrawContext = class DrawContext {
    constructor() { this.rects = []; this.labels = []; }
    setFillColor() {}
    fillRect(rect) { this.rects.push(rect); }
    setFont() {}
    setTextColor() {}
    setTextAlignedCenter() {}
    drawTextInRect(label) { this.labels.push(label); }
    getImage() { return { rects: this.rects, labels: this.labels }; }
  };
  context.Font = Object.fromEntries(['systemFont', 'mediumSystemFont', 'semiboldSystemFont', 'boldSystemFont']
    .map(name => [name, size => ({ name, size })]));
  context.URLScheme = { forRunningScript: () => 'scriptable:///run/Manual-Spending-Tracker' };
  context.config = { widgetFamily: 'small' };
  context.state = { expenses: [{ id: 'one', amount: 26.12, note: 'Lunch',
    category: 'Food & Drinks', date: new Date().toISOString() }], budget: 2000 };
  const render = family => {
    context.family = family;
    const widget = vm.runInContext('makeWidget(state, null, family)', context);
    const collect = node => node.children.flatMap(child => child.text === undefined ?
      (child.children ? collect(child) : []) : [child.text]);
    const images = node => node.children.flatMap(child => child.image ? [child.image] :
      (child.children ? images(child) : []));
    return { widget, texts: collect(widget), images: images(widget) };
  };
  const small = render('small'), medium = render('medium'), large = render('large');
  assert.ok(small.texts.some(text => text.includes('$26.12')));
  assert.ok(!small.texts.includes('TOP CATEGORIES'));
  assert.ok(medium.texts.includes('TOP CATEGORIES'));
  assert.ok(!medium.texts.includes('RECENT EXPENSES'));
  assert.equal(medium.images.length, 1);
  assert.ok(medium.widget.children.some(child => child.children?.some(grandchild =>
    grandchild.children?.some(item => item.text === 'TOP CATEGORIES'))));
  assert.ok(large.texts.includes('RECENT EXPENSES'));
  assert.ok(large.texts.includes('LAST 7 DAYS'));
  assert.ok(large.texts.includes('Lunch'));
  assert.equal(large.images.length, 2);
  assert.equal(large.images[1].labels.length, 7);
  assert.equal(large.images[1].rects.length, 7);
  assert.equal(large.images[1].rects.at(-1).height, 34);

  context.state = { expenses: [], budget: 0 };
  const empty = render('large');
  assert.ok(empty.texts.includes('No expenses yet'));
  assert.ok(empty.texts.includes('Nothing logged yet'));
  assert.equal(empty.images[1].rects.length, 7);

  context.state = { expenses: [{ id: 'today', amount: 26.12, note: 'Lunch',
    category: 'Food & Drinks', date: new Date().toISOString() }], budget: 2000 };
  const inline = render('accessoryInline');
  const circular = render('accessoryCircular');
  const rectangular = render('accessoryRectangular');
  assert.equal(inline.texts.length, 1);
  assert.match(inline.texts[0], /spent \$26\.12/);
  assert.deepEqual(circular.texts, ['TODAY', '$26.12']);
  assert.deepEqual(rectangular.texts, ['SPENT THIS MONTH', '$26.12', 'Today $26.12']);
  for (const accessory of [inline, circular, rectangular]) {
    assert.equal(accessory.widget.backgroundColor, undefined);
    assert.match(accessory.widget.url, /action=add$/);
    assert.equal(accessory.images.length, 0);
  }
  context.state = null;
  context.family = 'accessoryRectangular';
  const failure = vm.runInContext('makeWidget(state, new Error("iCloud unavailable"), family)', context);
  assert.equal(failure.children.find(child => child.text)?.text, 'Open spending tracker');
});
