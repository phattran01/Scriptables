/* Run in Scriptable to install or update Manual-Spending-Tracker.js from GitHub. */
const SOURCE_URL = "https://raw.githubusercontent.com/phattran01/Scriptables/main/Manual-Spending-Tracker.js";
const SCRIPT_NAME = "Manual-Spending-Tracker.js";
const BACKUP_NAME = "Manual-Spending-Tracker-backup.txt";

let title = "NOVA updated";
let message = "NOVA is ready in Scriptable.";

try {
  const request = new Request(SOURCE_URL);
  request.timeoutInterval = 30;
  const code = await request.loadString();
  if (request.response?.statusCode !== 200 ||
      !code.startsWith("/* Manual Spending Tracker") ||
      !code.includes('const DATA_NAME = "spending-tracker.json";')) {
    throw new Error("GitHub did not return the expected tracker script.");
  }

  const fm = FileManager.iCloud();
  const directory = fm.documentsDirectory();
  const target = fm.joinPath(directory, SCRIPT_NAME);
  const backup = fm.joinPath(directory, BACKUP_NAME);

  let previous = null;
  if (fm.fileExists(target)) {
    await fm.downloadFileFromiCloud(target);
    previous = fm.readString(target);
  }

  if (previous === code) {
    title = "Already up to date";
    message = "NOVA already matches GitHub.";
  } else {
    if (previous !== null) fm.writeString(backup, previous);
    fm.writeString(target, code);
    if (previous === null) title = "NOVA installed";
    message = previous === null
      ? "NOVA was installed as Manual-Spending-Tracker. Select that script in your widget."
      : "NOVA was updated. Your previous script code is saved as a .txt backup.";
  }
} catch (error) {
  title = "Install failed";
  message = String(error.message || error) + "\n\nThe spending data JSON was not changed.";
}

const alert = new Alert();
alert.title = title;
alert.message = message;
alert.addAction("OK");
await alert.presentAlert();
Script.complete();
