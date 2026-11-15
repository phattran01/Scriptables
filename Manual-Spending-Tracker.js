/*
 * MANUAL SPENDING TRACKER
 * Scriptable for iOS
 * No bank connection required
 */

const fm = FileManager.local();
const file = fm.joinPath(
  fm.documentsDirectory(),
  "spending-tracker.json"
);

const CATEGORIES = [
  "Food & Drinks",
  "Shopping",
  "Transportation",
  "Entertainment",
  "Bills",
  "Subscriptions",
  "Health",
  "Other"
];

const COLORS = [
  "#60A5FA",
  "#A78BFA",
  "#34D399",
  "#FBBF24",
  "#FB7185",
  "#22D3EE",
  "#F472B6",
  "#94A3B8"
];

const money = n => "$" + Number(n).toFixed(2);

// --------------------
// DATA STORAGE
// --------------------

function load() {
  if (!fm.fileExists(file)) return [];
  return JSON.parse(fm.readString(file));
}

function save(data) {
  fm.writeString(
    file,
    JSON.stringify(data, null, 2)
  );
}

// --------------------
// DATE HELPERS
// --------------------

function monthKey(date) {
  const d = new Date(date);
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0");
}

function dayKey(date) {
  const d = new Date(date);
  return monthKey(d) + "-" +
    String(d.getDate()).padStart(2, "0");
}

// --------------------
// ADD AN EXPENSE
// --------------------

async function addExpense() {
  const a = new Alert();
  a.title = "New Expense";
  a.message = "Enter your purchase details";

  a.addTextField("Amount (e.g. 14.50)");
  a.addTextField("Description (e.g. Lunch)");

  a.addAction("Next");
  a.addCancelAction("Cancel");

  if (await a.presentAlert() === -1) return;

  const amount = Number(
    a.textFieldValue(0)
      .trim()
      .replace(/[$,]/g, "")
  );

  const note = a.textFieldValue(1).trim();

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    const error = new Alert();
    error.title = "Invalid Amount";
    error.message =
      "Please enter an amount greater than zero.";
    error.addAction("OK");
    await error.presentAlert();
    return;
  }

  const choice = new Alert();
  choice.title = "Choose Category";

  CATEGORIES.forEach(c => choice.addAction(c));
  choice.addCancelAction("Cancel");

  const index = await choice.presentSheet();
  if (index === -1) return;

  const data = load();

  data.push({
    id: Date.now() + "-" + Math.random(),
    amount: Math.round(amount * 100) / 100,
    note: note || CATEGORIES[index],
    category: CATEGORIES[index],
    date: new Date().toISOString()
  });

  save(data);

  const done = new Alert();
  done.title = "Expense Saved";
  done.message =
    `${money(amount)} added to ${CATEGORIES[index]}`;
  done.addAction("Done");

  await done.presentAlert();
}

// --------------------
// VIEW EXPENSES
// --------------------

async function viewExpenses() {
  const data = load()
    .slice()
    .sort((a, b) =>
      new Date(b.date) - new Date(a.date)
    );

  const a = new Alert();
  a.title = "Recent Expenses";

  a.message = data.length
    ? data.slice(0, 12).map(e =>
        `${money(e.amount)} - ${e.note}\n` +
        `${e.category} | ` +
        new Date(e.date).toLocaleDateString()
      ).join("\n\n")
    : "No expenses logged yet.";

  a.addAction("OK");
  await a.presentAlert();
}

// --------------------
// DELETE LAST EXPENSE
// --------------------

async function deleteLast() {
  const data = load();

  if (!data.length) {
    const empty = new Alert();
    empty.title = "No Expenses";
    empty.message = "Nothing to delete.";
    empty.addAction("OK");
    await empty.presentAlert();
    return;
  }

  const last = data[data.length - 1];

  const a = new Alert();
  a.title = "Delete Last Expense?";
  a.message =
    `${money(last.amount)} - ${last.note}`;

  a.addDestructiveAction("Delete");
  a.addCancelAction("Cancel");

  if (await a.presentAlert() === 0) {
    data.pop();
    save(data);
  }
}

// --------------------
// WIDGET DESIGN
// --------------------

function makeWidget() {
  const data = load();
  const now = new Date();

  const month = monthKey(now);
  const today = dayKey(now);

  const monthly = data.filter(e =>
    monthKey(e.date) === month
  );

  const total = monthly.reduce(
    (sum, e) => sum + e.amount, 0
  );

  const todayTotal = monthly
    .filter(e => dayKey(e.date) === today)
    .reduce((sum, e) => sum + e.amount, 0);

  const grouped = {};

  for (const e of monthly) {
    grouped[e.category] =
      (grouped[e.category] || 0) + e.amount;
  }

  const categories = Object.entries(grouped)
    .sort((a, b) => b[1] - a[1]);

  const widget = new ListWidget();

  widget.backgroundColor =
    new Color("#111827");

  widget.setPadding(15, 16, 15, 16);
  widget.spacing = 5;

  // Header

  const header = widget.addText(
    "SPENDING TRACKER"
  );

  header.font =
    Font.semiboldSystemFont(10);

  header.textColor =
    new Color("#94A3B8");

  widget.addSpacer(4);

  // Month

  const monthLabel = widget.addText(
    now.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric"
    })
  );

  monthLabel.font = Font.systemFont(11);
  monthLabel.textColor =
    new Color("#94A3B8");

  // Total spending

  const amount = widget.addText(
    money(total)
  );

  amount.font =
    Font.boldSystemFont(27);

  amount.textColor = Color.white();
  amount.minimumScaleFactor = 0.6;
  amount.lineLimit = 1;

  // Daily spending and add button

  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  const daily = row.addText(
    "Today  " + money(todayTotal)
  );

  daily.font =
    Font.mediumSystemFont(11);

  daily.textColor =
    new Color("#CBD5E1");

  row.addSpacer();

  const plus = row.addText("+ Add");

  plus.font =
    Font.semiboldSystemFont(12);

  plus.textColor =
    new Color("#60A5FA");

  // Open the script directly in Add mode
  // when the widget is tapped.

  const baseURL = URLScheme.forRunningScript();
  widget.url = baseURL +
    (baseURL.includes("?") ? "&" : "?") +
    "action=add";

  widget.addSpacer(5);

  // Category section

  const section = widget.addText(
    "TOP CATEGORIES"
  );

  section.font =
    Font.semiboldSystemFont(9);

  section.textColor =
    new Color("#94A3B8");

  const limit =
    config.widgetFamily === "small" ? 2 : 4;

  if (!categories.length) {
    const empty = widget.addText(
      "No expenses yet"
    );

    empty.font =
      Font.systemFont(12);

    empty.textColor =
      new Color("#CBD5E1");
  }

  // Category rows

  for (
    const [category, value]
    of categories.slice(0, limit)
  ) {
    const idx = CATEGORIES.indexOf(category);

    const color =
      COLORS[idx] || "#94A3B8";

    const r = widget.addStack();
    r.layoutHorizontally();
    r.centerAlignContent();

    const name = r.addText(category);

    name.font =
      Font.systemFont(10);

    name.textColor =
      new Color(color);

    name.lineLimit = 1;
    name.minimumScaleFactor = 0.7;

    r.addSpacer(6);

    const val = r.addText(
      money(value)
    );

    val.font =
      Font.mediumSystemFont(10);

    val.textColor = Color.white();
    val.lineLimit = 1;
    val.minimumScaleFactor = 0.7;
  }

  // Refresh request
  // Actual timing is controlled by iOS.

  widget.refreshAfterDate =
    new Date(Date.now() + 5 * 60 * 1000);

  return widget;
}

// --------------------
// MAIN
// --------------------

if (config.runsInWidget) {

  Script.setWidget(makeWidget());

} else {

  const action = args.queryParameters?.action;

  if (action === "add") {

    await addExpense();

  } else {

    const menu = new Alert();
    menu.title = "Spending Tracker";
    menu.message =
      "What would you like to do?";

    menu.addAction("Add Expense");
    menu.addAction("View Expenses");
    menu.addAction("Delete Last Expense");
    menu.addAction("Preview Widget");
    menu.addCancelAction("Cancel");

    const selected =
      await menu.presentSheet();

    if (selected === 0) {

      await addExpense();

    } else if (selected === 1) {

      await viewExpenses();

    } else if (selected === 2) {

      await deleteLast();

    } else if (selected === 3) {

      await makeWidget().presentMedium();

    }
  }
}

Script.complete();
