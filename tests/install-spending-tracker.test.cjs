const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const installer = fs.readFileSync(path.join(__dirname, '..', 'Install-Spending-Tracker.js'), 'utf8');
const tracker = fs.readFileSync(path.join(__dirname, '..', 'Manual-Spending-Tracker.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runInstaller = new AsyncFunction('Request', 'FileManager', 'Alert', 'Script', installer);

function setup(responseCode = tracker, statusCode = 200) {
  const files = new Map([['cloud/spending-tracker.json', '[{"amount":25.12}]']]);
  const alerts = [];
  class Request {
    constructor(url) { assert.match(url, /raw\.githubusercontent\.com/); this.response = { statusCode }; }
    async loadString() { return responseCode; }
  }
  const fm = {
    documentsDirectory: () => 'cloud',
    joinPath: (dir, name) => dir + '/' + name,
    fileExists: file => files.has(file),
    downloadFileFromiCloud: async () => {},
    readString: file => files.get(file),
    writeString: (file, content) => files.set(file, content),
    move: (from, to) => {
      if (files.has(to)) throw new Error('Destination already exists');
      files.set(to, files.get(from)); files.delete(from);
    }
  };
  class Alert {
    addAction() {}
    async presentAlert() { alerts.push({ title: this.title, message: this.message }); }
  }
  return { files, alerts, run: () => runInstaller(Request, { iCloud: () => fm }, Alert, { complete() {} }) };
}

test('installer downloads code, backs up updates, and leaves spending data alone', async () => {
  const app = setup();
  await app.run();
  assert.equal(app.files.get('cloud/Manual-Spending-Tracker.js'), tracker);
  assert.equal(app.files.get('cloud/spending-tracker.json'), '[{"amount":25.12}]');
  assert.equal(app.alerts.at(-1).title, 'NOVA installed');
  assert.match(app.alerts.at(-1).message, /installed as Manual-Spending-Tracker/);

  app.files.set('cloud/Manual-Spending-Tracker.js', 'previous script');
  await app.run();
  assert.equal(app.files.get('cloud/Manual-Spending-Tracker-backup.txt'), 'previous script');
  assert.equal(app.files.get('cloud/Manual-Spending-Tracker.js'), tracker);
  assert.equal(app.alerts.at(-1).title, 'NOVA updated');

  await app.run();
  assert.equal(app.alerts.at(-1).title, 'Already up to date');
  assert.equal(app.files.get('cloud/Manual-Spending-Tracker-backup.txt'), 'previous script');
});

test('installer rejects an unexpected download without overwriting the script', async () => {
  const app = setup('<html>Not Found</html>', 404);
  app.files.set('cloud/Manual-Spending-Tracker.js', 'previous script');
  await app.run();
  assert.equal(app.files.get('cloud/Manual-Spending-Tracker.js'), 'previous script');
  assert.equal(app.alerts.at(-1).title, 'Install failed');
});
