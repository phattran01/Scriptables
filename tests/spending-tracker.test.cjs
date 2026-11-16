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
  const exports = [];
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
    DocumentPicker: { exportString: async (body, name) => { exports.push({ body, name }); } },
    console
  };
  vm.createContext(context);
  vm.runInContext(library, context);
  return { context, files, views, exports };
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

  await send({ type: 'subscriptionSave', id: null, name: 'Music', amount: '9.99',
    cadence: 'monthly', nextDate: '2026-12-15' }, 'Subscription added');
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker-subscriptions.json'))[0].name, 'Music');
  assert.match(web.loads.at(-1), /"initialTab":"subscriptions"/);

  await send({ type: 'save', id: null, amount: 'bad', note: 'Nope',
    category: 'Food & Drinks', date: '2026-11-15' }, 'Enter dollars');
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker.json')).length, 2);

  const added = JSON.parse(files.cloud.get('cloud/spending-tracker.json'))[1];
  await send({ type: 'delete', id: added.id }, 'Expense deleted');
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker.json')).length, 1);

  web.dismiss();
  await running;
});

test('confirmed subscriptions save separately, preserve backups, and export with the target', async () => {
  const { context, files, exports } = setup();
  const expense = { id: 'old', amount: 21.27, note: 'ChatGPT', category: 'Subscriptions',
    date: '2026-11-13T12:00:00.000Z' };
  files.cloud.set('cloud/spending-tracker.json', JSON.stringify([expense]));
  files.cloud.set('cloud/spending-tracker-settings.json', JSON.stringify({ monthlyBudget: 2000 }));
  context.state = { expenses: [expense], budget: 2000, subscriptions: [] };
  async function act(action) {
    context.action = action;
    return vm.runInContext('handleAction(state, action)', context);
  }
  assert.equal(await act({ type: 'subscriptionSave', id: null, name: 'ChatGPT', amount: '21.27',
    cadence: 'monthly', nextDate: '2026-12-13' }), 'Subscription added');
  const first = JSON.parse(files.cloud.get('cloud/spending-tracker-subscriptions.json'));
  assert.equal(first[0].name, 'ChatGPT');
  assert.equal(first[0].active, true);
  assert.equal(files.cloud.get('cloud/spending-tracker.json'), JSON.stringify([expense]));

  await assert.rejects(act({ type: 'subscriptionSave', id: null, name: 'chatgpt', amount: '21.27',
    cadence: 'monthly', nextDate: '2026-12-13' }), /already tracked/);
  await assert.rejects(act({ type: 'subscriptionSave', id: null, name: 'Invalid', amount: '5',
    cadence: 'monthly', nextDate: '2026-02-31' }), /valid date/);
  await assert.rejects(act({ type: 'subscriptionSave', id: null, name: 'Invalid', amount: '5',
    cadence: 'fortnightly', nextDate: '2026-12-14' }), /how often/);
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker-subscriptions.json')).length, 1);

  const id = first[0].id;
  assert.equal(await act({ type: 'subscriptionSave', id, name: 'ChatGPT Plus', amount: '22.00',
    cadence: 'monthly', nextDate: '2026-12-14' }), 'Subscription updated');
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker-subscriptions-backup.json'))[0].name, 'ChatGPT');
  assert.equal(await act({ type: 'subscriptionToggle', id }), 'Subscription paused');
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker-subscriptions.json'))[0].active, false);
  await act({ type: 'subscriptionSave', id, name: 'ChatGPT Plus', amount: '23.00',
    cadence: 'monthly', nextDate: '2027-01-14' });
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker-subscriptions.json'))[0].active, false);
  await act({ type: 'exportBackup' });
  assert.equal(exports.at(-1).name, 'NOVA-complete-backup.json');
  const backup = JSON.parse(exports.at(-1).body);
  assert.equal(backup.monthlyBudget, 2000);
  assert.equal(backup.expenses[0].note, 'ChatGPT');
  assert.equal(backup.subscriptions[0].name, 'ChatGPT Plus');
  assert.equal(backup.subscriptions[0].active, false);
  assert.equal(await act({ type: 'subscriptionRemove', id }), 'Subscription removed');
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker-subscriptions.json')).length, 0);
  assert.equal(JSON.parse(files.cloud.get('cloud/spending-tracker.json')).length, 1);
  const loaded = await vm.runInContext('loadState()', context);
  assert.equal(loaded.budget, 2000);
  assert.equal(loaded.subscriptions.length, 0);
  files.cloud.set('cloud/spending-tracker-subscriptions.json', '{"broken":true}');
  await assert.rejects(act({ type: 'subscriptionSave', id: null, name: 'Music', amount: '5',
    cadence: 'monthly', nextDate: '2026-12-14' }), /subscriptions JSON is invalid/);
  assert.equal(files.cloud.get('cloud/spending-tracker-subscriptions.json'), '{"broken":true}');
  await assert.rejects(vm.runInContext('loadState()', context), /subscriptions JSON is invalid/);
  assert.equal((await vm.runInContext('loadState(false)', context)).expenses.length, 1);
});

test('embedded WebView JavaScript parses', () => {
  const { context } = setup();
  const html = vm.runInContext('makeHTML({expenses:[],budget:0}, false)', context);
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match);
  new vm.Script(match[1]);
  assert.match(html, /<title>NOVA<\/title>/);
  assert.match(html, /<h1>NOVA<\/h1>/);
  assert.match(html, /class="amount-entry"/);
  assert.match(html, /id="categoryChips"/);
  assert.match(html, /id="dateDetails" hidden/);
});

function renderPage(state) {
  const { context } = setup();
  context.state = state;
  const html = vm.runInContext('makeHTML(state, false)', context);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  class Element {
    constructor() {
      this.children = [];
      this.style = {};
      this.value = '';
      this.dataset = {};
      this.attributes = {};
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
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() {}
  }
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get('progress').firstElementChild = new Element();
  const nav = ['overview', 'history', 'subscriptions', 'settings'].map(tab => {
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
  return { get, page };
}

test('quick entry sends the selected category and date', () => {
  const { get, page } = renderPage({ expenses: [{ id: 'old', amount: 25.12, note: 'panda',
    category: 'Food & Drinks', date: new Date().toISOString() }], budget: 0 });
  get('addTop').onclick();
  assert.equal(get('categoryChips').children[0].dataset.category, 'Food & Drinks');
  assert.equal(get('categoryInput').value, 'Food & Drinks');
  assert.equal(get('dateDetails').hidden, true);
  get('amountInput').value = '14.50';
  const health = get('categoryChips').children.find(chip => chip.dataset.category === 'Health');
  health.onclick();
  assert.equal(get('categoryInput').value, 'Health');
  assert.equal(health.attributes['aria-pressed'], 'true');
  get('dateToggle').onclick();
  assert.equal(get('dateDetails').hidden, false);
  get('dateInput').value = '2026-11-14';
  get('dateInput').onchange();
  assert.match(get('dateToggle').textContent, /Nov 14, 2026/);
  get('expenseForm').onsubmit({ preventDefault() {} });
  const payload = JSON.parse(decodeURIComponent(page.window.location.href.split('payload=')[1]));
  assert.equal(payload.type, 'save');
  assert.equal(payload.id, null);
  assert.equal(payload.amount, '14.50');
  assert.equal(payload.category, 'Health');
  assert.equal(payload.date, '2026-11-14');
});

test('subscription suggestions require confirmation and the list can pause or remove entries', () => {
  const expense = { id: 'old', amount: 21.27, note: 'ChatGPT', category: 'Subscriptions',
    date: new Date().toISOString() };
  const suggestion = renderPage({ expenses: [expense], budget: 2000, subscriptions: [] });
  assert.equal(suggestion.get('subPreviewTotal').textContent, 'Set up your list');
  assert.equal(suggestion.get('subSuggestionsSection').hidden, false);
  suggestion.get('seeSubs').onclick();
  assert.equal(suggestion.get('subscriptions').hidden, false);
  suggestion.get('subSuggestions').children[0].onclick();
  assert.equal(suggestion.get('subName').value, 'ChatGPT');
  assert.equal(suggestion.get('subAmount').value, '21.27');
  assert.equal(suggestion.get('subCadence').value, '');
  assert.equal(suggestion.get('subNextDate').value, '');
  suggestion.get('subCadence').value = 'monthly';
  suggestion.get('subNextDate').value = '2026-12-13';
  suggestion.get('subForm').onsubmit({ preventDefault() {} });
  const save = JSON.parse(decodeURIComponent(suggestion.page.window.location.href.split('payload=')[1]));
  assert.equal(save.type, 'subscriptionSave');
  assert.equal(save.name, 'ChatGPT');
  assert.equal(save.nextDate, '2026-12-13');

  const item = { id: 'sub1', name: 'ChatGPT', amount: 21.27, cadence: 'monthly',
    nextDate: '2026-12-13', active: true };
  const paused = renderPage({ expenses: [expense], budget: 2000, subscriptions: [item] });
  assert.equal(paused.get('subPreviewTotal').textContent, '$21.27/mo');
  assert.equal(paused.get('subSuggestionsSection').hidden, true);
  paused.get('subList').children[0].onclick();
  paused.get('subToggle').onclick();
  const toggle = JSON.parse(decodeURIComponent(paused.page.window.location.href.split('payload=')[1]));
  assert.equal(toggle.type, 'subscriptionToggle');
  assert.equal(toggle.id, 'sub1');

  const equivalents = renderPage({ expenses: [], budget: 0, subscriptions: [
    { id: 'year', name: 'Yearly', amount: 120, cadence: 'yearly', nextDate: '2027-11-14', active: true },
    { id: 'week', name: 'Weekly', amount: 12, cadence: 'weekly', nextDate: '2026-11-20', active: true }
  ] });
  assert.equal(equivalents.get('subPreviewTotal').textContent, '$62.00/mo');

  const removal = renderPage({ expenses: [expense], budget: 2000, subscriptions: [item] });
  removal.get('subList').children[0].onclick();
  removal.get('removeSub').onclick();
  assert.match(removal.get('deleteMessage').textContent, /Logged expenses stay/);
  removal.get('confirmDelete').onclick();
  const remove = JSON.parse(decodeURIComponent(removal.page.window.location.href.split('payload=')[1]));
  assert.equal(remove.type, 'subscriptionRemove');
  assert.equal(remove.id, 'sub1');
});

test('delete button opens in-page confirmation and submits the selected expense', () => {
  const { get, page } = renderPage({ expenses: [{ id: 'old', amount: 25.12, note: 'panda',
    category: 'Food & Drinks', date: new Date().toISOString() }], budget: 0 });
  get('recent').children[0].onclick();
  assert.equal(get('categoryInput').value, 'Food & Drinks');
  assert.equal(get('saveExpense').textContent, 'Save changes');
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
  assert.ok(small.texts.includes('NOVA'));
  assert.ok(medium.texts.includes('NOVA'));
  assert.ok(large.texts.includes('NOVA'));
  assert.ok(small.texts.some(text => text.includes('$26.12')));
  assert.ok(!small.texts.includes('TOP CATEGORIES'));
  assert.ok(medium.texts.includes('TOP CATEGORIES'));
  assert.ok(!medium.texts.includes('RECENT EXPENSES'));
  assert.equal(medium.images.length, 0);
  assert.ok(medium.texts.includes('Latest · Lunch'));
  assert.ok(medium.texts.some(text => text.startsWith('Updated ')));
  assert.ok(medium.widget.children.some(child => child.children?.some(grandchild =>
    grandchild.children?.some(item => item.text === 'TOP CATEGORIES'))));
  assert.ok(large.texts.includes('RECENT EXPENSES'));
  assert.ok(large.texts.includes('LAST 7 DAYS'));
  assert.ok(large.texts.includes('Lunch'));
  assert.equal(large.images.length, 2);
  assert.equal(large.images[1].labels.length, 7);
  assert.equal(large.images[1].rects.length, 7);
  assert.equal(large.images[1].rects.at(-1).height, 34);

  context.state = { expenses: [{ id: 'large', amount: 1973.88, note: 'Rent',
    category: 'Bills', date: new Date().toISOString() }], budget: 2000, subscriptions: [] };
  assert.ok(render('medium').texts.includes('$1,973.88'));

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
  assert.deepEqual(rectangular.texts, ['NOVA · MONTH', '$26.12', 'Today $26.12']);
  for (const accessory of [inline, circular, rectangular]) {
    assert.equal(accessory.widget.backgroundColor, undefined);
    assert.match(accessory.widget.url, /action=add$/);
    assert.equal(accessory.images.length, 0);
  }
  context.state = null;
  context.family = 'accessoryRectangular';
  const failure = vm.runInContext('makeWidget(state, new Error("iCloud unavailable"), family)', context);
  assert.equal(failure.children.find(child => child.text)?.text, 'Open NOVA');
});
