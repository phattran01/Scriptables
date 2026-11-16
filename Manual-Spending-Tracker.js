/* Manual Spending Tracker (NOVA) for Scriptable. Data is stored in iCloud Drive. */
const CATEGORIES = ["Food & Drinks", "Shopping", "Transportation", "Entertainment", "Bills", "Subscriptions", "Health", "Other"];
const COLORS = ["#60A5FA", "#A78BFA", "#34D399", "#FBBF24", "#FB7185", "#22D3EE", "#F472B6", "#94A3B8"];
const DATA_NAME = "spending-tracker.json";
const SUBSCRIPTIONS_NAME = "spending-tracker-subscriptions.json";
const CADENCES = ["weekly", "monthly", "yearly"];
const localFM = FileManager.local();
const legacyPath = localFM.joinPath(localFM.documentsDirectory(), DATA_NAME);

function paths() {
  const fm = FileManager.iCloud(), dir = fm.documentsDirectory();
  return { fm, data: fm.joinPath(dir, DATA_NAME), backup: fm.joinPath(dir, "spending-tracker-backup.json"),
    settings: fm.joinPath(dir, "spending-tracker-settings.json"),
    subscriptions: fm.joinPath(dir, SUBSCRIPTIONS_NAME),
    subscriptionsBackup: fm.joinPath(dir, "spending-tracker-subscriptions-backup.json") };
}
function checkData(raw) {
  const data = JSON.parse(raw);
  if (!Array.isArray(data) || data.some(e => !e || !Number.isFinite(e.amount) || e.amount <= 0 ||
    typeof e.date !== "string" || !Number.isFinite(Date.parse(e.date)) ||
    typeof e.note !== "string" || typeof e.category !== "string")) {
    throw new Error("The spending JSON is invalid. No changes were made.");
  }
  return data;
}
function checkSubscriptions(raw) {
  const items = JSON.parse(raw);
  if (!Array.isArray(items) || items.some(item => !item ||
    typeof item.id !== "string" || typeof item.name !== "string" || !item.name.trim() ||
    !Number.isFinite(item.amount) || item.amount <= 0 || !CADENCES.includes(item.cadence) ||
    typeof item.nextDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.nextDate) ||
    !Number.isFinite(Date.parse(item.nextDate + "T12:00:00")) ||
    dayOf(item.nextDate + "T12:00:00") !== item.nextDate || typeof item.active !== "boolean")) {
    throw new Error("The subscriptions JSON is invalid. No changes were made.");
  }
  return items;
}
async function readFile(fm, path) { await fm.downloadFileFromiCloud(path); return fm.readString(path); }
async function loadState(includeSubscriptions = true) {
  const p = paths(); let expenses = [];
  if (p.fm.fileExists(p.data)) expenses = checkData(await readFile(p.fm, p.data));
  else if (localFM.fileExists(legacyPath)) {
    expenses = checkData(localFM.readString(legacyPath));
    p.fm.writeString(p.data, JSON.stringify(expenses, null, 2)); // Keep the local original.
  }
  let budget = 0;
  if (p.fm.fileExists(p.settings)) {
    const settings = JSON.parse(await readFile(p.fm, p.settings));
    if (Number.isFinite(settings.monthlyBudget) && settings.monthlyBudget >= 0) budget = settings.monthlyBudget;
  }
  const subscriptions = includeSubscriptions && p.fm.fileExists(p.subscriptions) ?
    checkSubscriptions(await readFile(p.fm, p.subscriptions)) : [];
  return { expenses, budget, subscriptions };
}
async function saveExpenses(data) {
  const p = paths();
  if (p.fm.fileExists(p.data)) {
    const previous = await readFile(p.fm, p.data);
    checkData(previous);
    p.fm.writeString(p.backup, previous);
  }
  // Scriptable's iCloud manager can refuse move() when the destination exists.
  // writeString() explicitly supports overwriting; the prior JSON is backed up above.
  p.fm.writeString(p.data, JSON.stringify(data, null, 2));
}
function saveBudget(budget) { const p = paths(); p.fm.writeString(p.settings, JSON.stringify({ monthlyBudget: budget }, null, 2)); }
async function saveSubscriptions(items) {
  const p = paths();
  if (p.fm.fileExists(p.subscriptions)) {
    const previous = await readFile(p.fm, p.subscriptions);
    checkSubscriptions(previous);
    p.fm.writeString(p.subscriptionsBackup, previous);
  }
  p.fm.writeString(p.subscriptions, JSON.stringify(items, null, 2));
}
function amountFrom(value, zeroOK = false) {
  const raw = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error("Enter dollars with up to two decimal places.");
  const cents = Math.round(Number(raw) * 100);
  if (!Number.isSafeInteger(cents) || (!zeroOK && cents <= 0)) throw new Error("Enter an amount greater than zero.");
  return cents / 100;
}
function dayOf(value) {
  const d = new Date(value);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function dateFor(day, previous) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Choose a valid date.");
  const d = new Date(day + "T12:00:00");
  if (!Number.isFinite(d.getTime()) || dayOf(d) !== day) throw new Error("Choose a valid date.");
  if (previous && dayOf(previous) === day) return previous;
  return (!previous && day === dayOf(new Date()) ? new Date() : d).toISOString();
}
const monthOf = value => dayOf(value).slice(0, 7);
const money = value => {
  const [dollars, cents] = Number(value).toFixed(2).split(".");
  return "$" + dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + cents;
};
const safeJSON = value => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
function exportCSV(data) {
  const q = value => '"' + String(value).replace(/"/g, '""') + '"';
  return ["Date,Amount,Description,Category", ...data.slice().sort((a, b) => a.date.localeCompare(b.date))
    .map(e => [dayOf(e.date), Number(e.amount).toFixed(2), e.note, e.category].map(q).join(","))].join("\r\n");
}

function makeHTML(state, startAdding, status = "", initialTab = "overview", attempt = null, subscriptionAttempt = null) {
  const boot = safeJSON({ ...state, subscriptions: state.subscriptions || [], categories: CATEGORIES,
    colors: COLORS, startAdding, status, initialTab, attempt, subscriptionAttempt });
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>NOVA</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#f8fafc;background:#0b1220}*{box-sizing:border-box}body{margin:0;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}button,input,select{font:inherit}button{cursor:pointer}
main{max-width:650px;margin:auto;padding:22px 18px 45px}h1{font-size:30px;letter-spacing:-.04em;margin:6px 0 4px}h2{font-size:17px;margin:0 0 14px}.eyebrow{font-size:11px;letter-spacing:.15em;font-weight:800;color:#91a2bd}.muted{color:#9caec9}.top,.section-head,.expense,.sheet-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.top{align-items:flex-start}.section-head{margin:24px 2px 12px}.section-head h2{margin:0}
.primary,.secondary,.danger,.nav button{border-radius:12px;padding:11px 15px;font-weight:750}.primary{background:#60a5fa;border:0;color:#061324}.secondary,.nav button{background:#172338;border:1px solid #31405a;color:#dce8fa}.danger{background:#422431;border:1px solid #b25169;color:#ffdce4}.nav{display:flex;gap:7px;margin:23px 0 19px}.nav button{flex:1;padding:10px 6px;font-size:13px}.nav button.active{background:#27466d;border-color:#60a5fa;color:white}
.card{background:#151f31;border:1px solid #2a3952;border-radius:20px;padding:19px;margin-bottom:14px}.hero{background:linear-gradient(145deg,#1b2d49,#142034)}.amount{font-size:42px;font-weight:800;letter-spacing:-.05em;margin:6px 0}.stats{display:flex;gap:14px;margin-top:18px}.stat{flex:1}.stat strong{display:block;font-size:17px;margin-top:4px}.progress{height:9px;background:#30415b;border-radius:9px;overflow:hidden;margin:16px 0 8px}.progress span{display:block;height:100%;background:#60a5fa}.progress span.over{background:#fb7185}
.cat{display:grid;grid-template-columns:1fr auto;gap:5px 14px;margin:15px 0}.bar{grid-column:1/-1;height:5px;background:#26344c;border-radius:5px;overflow:hidden}.bar span{display:block;height:100%}.list{display:grid;gap:9px}.expense{width:100%;text-align:left;background:#172338;border:1px solid #2c3c56;border-radius:14px;padding:13px;color:white}.expense .note{font-weight:700}.expense small{display:block;color:#96a9c6;margin-top:4px}.expense b{white-space:nowrap}.empty{padding:18px 0;color:#9caec9}
label{display:block;color:#a8b9d0;font-size:13px;font-weight:700;margin:15px 0 7px}input,select{width:100%;border:1px solid #3b4c65;border-radius:12px;background:#101a2b;color:white;padding:13px;outline:none}input:focus,select:focus{border-color:#60a5fa}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.actions{display:flex;gap:9px;margin-top:18px}.actions button{flex:1}.hint{font-size:12px;line-height:1.5;color:#90a4bf}
.overlay{position:fixed;inset:0;background:#040912c9;z-index:10;display:none;align-items:flex-end}.overlay.open{display:flex}.sheet{background:#172338;border:1px solid #3a4e69;border-radius:24px 24px 0 0;padding:24px 20px calc(25px + env(safe-area-inset-bottom));width:100%;max-width:650px;margin:auto;max-height:90vh;overflow:auto}.sheet-head button{background:none;border:0;color:#b6c6dc;font-size:28px}.error{color:#fda4af;min-height:19px;font-size:13px;margin-top:10px}.toast{position:fixed;bottom:25px;left:18px;right:18px;max-width:600px;margin:auto;background:#25446b;border:1px solid #5687bf;border-radius:13px;padding:13px 16px;z-index:20;display:none}
.confirm-overlay{position:fixed;inset:0;background:#040912d9;z-index:15;display:none;align-items:center;justify-content:center;padding:20px}.confirm-overlay.open{display:flex}.confirm-card{width:100%;max-width:400px;background:#1c2a40;border:1px solid #4b5d78;border-radius:20px;padding:22px}.confirm-card p{color:#b7c6d9;line-height:1.45}
.sheet{padding:18px 18px calc(14px + env(safe-area-inset-bottom));max-height:90vh;max-height:calc(100dvh - 12px)}.sheet-head h2{margin:0}.sheet-head{margin-bottom:12px}.form-label{display:block;color:#a8b9d0;font-size:12px;font-weight:700;margin:12px 0 6px}.form-label small{font-weight:400;color:#90a4bf}.amount-entry{display:flex;align-items:center;gap:5px;background:#101a2b;border:1px solid #3b4c65;border-radius:14px;padding:3px 13px}.amount-entry:focus-within{border-color:#60a5fa}.amount-entry span{font-size:29px;font-weight:700;color:#9caec9}.amount-entry input{border:0;background:transparent;padding:7px 0;font-size:32px;font-weight:750;min-width:0}.amount-entry input:focus{border:0}.category-strip{display:flex;gap:7px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;padding:2px 0 5px}.category-strip::-webkit-scrollbar{display:none}.category-chip{flex:none;border:1px solid #405473;background:#101a2b;color:#dce8fa;border-radius:999px;padding:9px 12px;font-size:13px;font-weight:650;white-space:nowrap}.category-chip.active{background:#60a5fa;border-color:#60a5fa;color:#081729}.quick-note{margin-top:2px}.form-footer{display:flex;align-items:center;gap:10px;margin-top:13px}.form-footer .primary{flex:1;padding:14px}.form-footer .danger{padding:14px}.date-toggle{border:0;background:none;color:#9bc5fa;font-size:13px;padding:10px 0 2px;text-align:left}.date-details label{margin:8px 0 5px}.date-details input{padding:10px}.error:empty{display:none}.error:not(:empty){min-height:0;margin-top:10px}
main{padding-top:16px}h1{font-size:28px}.nav{margin:16px 0 18px;gap:5px}.nav button{padding:9px 4px;font-size:12px}.summary-mini{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 17px}.summary-mini strong{font-size:20px}.small-amount{font-size:34px}.sub-row{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;background:#172338;border:1px solid #2c3c56;border-radius:14px;padding:14px;color:white}.sub-row strong{display:block;font-size:15px}.sub-row small{display:block;color:#96a9c6;margin-top:4px}.sub-row .sub-price{font-weight:750;white-space:nowrap;text-align:right}.sub-row.paused{opacity:.65}.sub-hint{margin:8px 2px 14px}.sub-preview{cursor:pointer}.sub-preview .muted{text-align:right}
.sub-preview{width:100%}.summary-mini .eyebrow{display:block;margin-bottom:4px}.sub-remove{display:block;width:100%;margin-top:10px}.sub-remove[hidden]{display:none}
</style></head><body><main>
<div class="top"><div><div class="eyebrow">YOUR MONEY</div><h1>NOVA</h1><div class="muted">Know where your money went.</div></div><button class="primary" id="addTop">+ Add</button></div>
<nav class="nav"><button class="active" data-tab="overview">Overview</button><button data-tab="history">History</button><button data-tab="subscriptions">Subs</button><button data-tab="settings">Settings</button></nav>
<section id="overview"><div class="card hero"><div class="eyebrow" id="heroMonth"></div><div class="amount" id="heroAmount"></div><div class="muted" id="budgetLine"></div><div class="progress" id="progress" hidden><span></span></div><div class="stats"><div class="stat"><div class="muted">Today</div><strong id="todayAmount"></strong></div><div class="stat"><div class="muted">Transactions</div><strong id="count"></strong></div></div></div><button class="card summary-mini sub-preview" id="seeSubs"><span><span class="eyebrow">SUBSCRIPTIONS</span><strong id="subPreviewTotal"></strong></span><span class="muted" id="subPreviewCount"></span></button><div class="section-head"><h2>Top categories</h2></div><div class="card" id="categories"></div><div class="section-head"><h2>Recent expenses</h2><button class="secondary" id="seeAll">See all</button></div><div class="list" id="recent"></div></section>
<section id="history" hidden><div class="section-head"><h2>Expense history</h2><button class="primary" id="addHistory">+ Add</button></div><label for="monthFilter">Month</label><select id="monthFilter"></select><div class="section-head"><div class="muted" id="historySummary"></div></div><div class="card" id="historyCategories"></div><div class="list" id="historyList"></div></section>
<section id="subscriptions" hidden><div class="section-head"><h2>Subscriptions</h2><button class="primary" id="addSubscription">+ Add</button></div><div class="card hero"><div class="eyebrow">ACTIVE COMMITMENTS</div><div class="amount small-amount" id="subMonthlyTotal"></div><div class="muted" id="subCount"></div><p class="hint">Monthly equivalent for planning. Charges enter your spending total only when logged as expenses.</p></div><div class="list" id="subList"></div><div id="subSuggestionsSection" hidden><div class="section-head"><h2>From your history</h2></div><p class="hint sub-hint">Possible subscriptions from logged expenses. Confirm the billing cycle and next renewal before tracking.</p><div class="list" id="subSuggestions"></div></div></section>
<section id="settings" hidden><div class="card"><h2>Monthly spending target</h2><div class="muted">Set a guide for your total spending each month.</div><label for="budgetInput">Target in dollars</label><input id="budgetInput" inputmode="decimal" placeholder="e.g. 1200.00"><div class="actions"><button class="primary" id="saveBudget">Save target</button></div><p class="hint">Enter 0 to turn off the target.</p></div><div class="card"><h2>Your data</h2><p class="muted">Expenses, target, and subscriptions live in iCloud Drive → Scriptable. Changes to expenses and subscriptions keep the prior JSON as a backup.</p><div class="actions"><button class="secondary" id="exportCSV">Expenses CSV</button><button class="secondary" id="exportJSON">Expenses JSON</button></div><div class="actions"><button class="secondary" id="exportBackup">Export complete backup</button></div><p class="hint">The complete backup includes expenses, subscriptions, and your target.</p></div></section>
</main><div class="overlay" id="overlay"><div class="sheet"><div class="sheet-head"><h2 id="formTitle">New expense</h2><button id="closeForm" aria-label="Close">×</button></div><form id="expenseForm"><label class="form-label" for="amountInput">Amount</label><div class="amount-entry"><span>$</span><input id="amountInput" inputmode="decimal" autocomplete="off" placeholder="0.00" required></div><div class="form-label">Category</div><div class="category-strip" id="categoryChips" role="group" aria-label="Category"></div><input id="categoryInput" type="hidden"><label class="form-label" for="noteInput">Description <small>optional</small></label><input class="quick-note" id="noteInput" placeholder="What was it for?" maxlength="120"><button type="button" class="date-toggle" id="dateToggle">Today · Change date</button><div class="date-details" id="dateDetails" hidden><label for="dateInput">Expense date</label><input id="dateInput" type="date" required></div><div class="error" id="formError"></div><div class="form-footer"><button type="button" class="danger" id="deleteExpense" hidden>Delete</button><button type="submit" class="primary" id="saveExpense">Save expense</button></div></form></div></div><div class="overlay" id="subOverlay"><div class="sheet"><div class="sheet-head"><h2 id="subFormTitle">Track subscription</h2><button id="closeSubForm" aria-label="Close">×</button></div><form id="subForm"><label class="form-label" for="subName">Name</label><input id="subName" maxlength="120" placeholder="e.g. Music or iCloud+" required><div class="two"><div><label class="form-label" for="subAmount">Charge</label><input id="subAmount" inputmode="decimal" placeholder="0.00" required></div><div><label class="form-label" for="subCadence">Billed</label><select id="subCadence" required><option value="">Choose</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="weekly">Weekly</option></select></div></div><label class="form-label" for="subNextDate">Next renewal</label><input id="subNextDate" type="date" required><div class="error" id="subError"></div><div class="form-footer"><button type="button" class="secondary" id="subToggle" hidden>Pause</button><button type="submit" class="primary" id="saveSub">Save subscription</button></div><button type="button" class="secondary sub-remove" id="removeSub" hidden>Remove subscription</button></form></div></div><div class="confirm-overlay" id="deleteDialog" role="alertdialog" aria-modal="true"><div class="confirm-card"><h2 id="deleteTitle">Delete this expense?</h2><p id="deleteMessage"></p><div class="actions"><button type="button" class="secondary" id="cancelDelete">Cancel</button><button type="button" class="danger" id="confirmDelete">Delete expense</button></div></div></div><div class="toast" id="toast"></div>
<script>
const boot=${boot};let expenses=boot.expenses,budget=boot.budget,subscriptions=boot.subscriptions,editing=null,editingSub=null,deletingType='delete',sending=false;
window.__novaReplyTimer=null;
function send(action){
 if(sending)return;
 sending=true;
 clearTimeout(window.__novaReplyTimer);
 window.__novaReplyTimer=setTimeout(()=>{
  sending=false;
  byId('formError').textContent='Scriptable did not respond. Close and reopen the tracker.';
  byId('subError').textContent='Scriptable did not respond. Close and reopen NOVA.';
  toast('Scriptable did not respond. Close and reopen the tracker.');
 },8000);
 window.location.href='https://scriptable-action.invalid/submit?payload='+encodeURIComponent(JSON.stringify(action));
}
const byId=id=>document.getElementById(id);
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
function day(s){const d=new Date(s);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
const month=s=>day(s).slice(0,7),today=()=>day(new Date());
const monthLabel=k=>new Date(k+'-01T12:00:00').toLocaleDateString('en-US',{month:'long',year:'numeric'});
const total=list=>list.reduce((n,e)=>n+Math.round(e.amount*100),0)/100;
const sorted=list=>list.slice().sort((a,b)=>b.date.localeCompare(a.date));
const monthlyEquivalent=s=>s.amount*(s.cadence==='weekly'?52/12:s.cadence==='yearly'?1/12:1);
function el(tag,cls,text){const x=document.createElement(tag);if(cls)x.className=cls;if(text!==undefined)x.textContent=text;return x}
function showTab(name){for(const id of ['overview','history','subscriptions','settings'])byId(id).hidden=id!==name;document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));render()}
function expenseRow(e){const b=el('button','expense');b.type='button';const left=el('span');left.append(el('span','note',e.note||e.category),el('small','',e.category+' · '+new Date(e.date).toLocaleDateString()));b.append(left,el('b','',money(e.amount)));b.onclick=()=>openForm(e);return b}
function subRow(s){
 const b=el('button','sub-row'+(s.active?'':' paused'));b.type='button';
 const renewal=new Date(s.nextDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
 const detail=s.active?s.cadence+' · '+(s.nextDate<today()?'Review date ':'Next ')+renewal:'Paused · '+s.cadence;
 const left=el('span');left.append(el('strong','',s.name),el('small','',detail));
 b.append(left,el('span','sub-price',money(s.amount)));b.onclick=()=>openSubForm(s);return b;
}
function renderSubscriptions(){
 const active=subscriptions.filter(s=>s.active).sort((a,b)=>a.nextDate.localeCompare(b.nextDate));
 const paused=subscriptions.filter(s=>!s.active).sort((a,b)=>a.name.localeCompare(b.name));
 const monthly=active.reduce((sum,s)=>sum+monthlyEquivalent(s),0);
 byId('subMonthlyTotal').textContent=money(monthly)+' / month';
 byId('subCount').textContent=active.length+' active'+(paused.length?' · '+paused.length+' paused':'');
 byId('subPreviewTotal').textContent=active.length?money(monthly)+'/mo':'Set up your list';
 byId('subPreviewCount').textContent=active.length?active.length+' active →':'Review →';
 const list=byId('subList');list.replaceChildren();
 if(!subscriptions.length)list.append(el('div','empty','No subscriptions confirmed yet. Add one or review suggestions below.'));
 else [...active,...paused].forEach(s=>list.append(subRow(s)));
 const known=new Set(subscriptions.map(s=>s.name.trim().toLowerCase()));
 const seen=new Set(),candidates=[];
 for(const e of sorted(expenses.filter(e=>e.category==='Subscriptions'))){const key=e.note.trim().toLowerCase();if(!key||known.has(key)||seen.has(key))continue;seen.add(key);candidates.push(e)}
 byId('subSuggestionsSection').hidden=!candidates.length;
 const suggestions=byId('subSuggestions');suggestions.replaceChildren();
 for(const e of candidates){const b=el('button','sub-row');b.type='button';const left=el('span');left.append(el('strong','',e.note),el('small','', 'Last logged '+new Date(e.date).toLocaleDateString('en-US',{month:'short',day:'numeric'})));b.append(left,el('span','sub-price',money(e.amount)));b.onclick=()=>openSubForm({name:e.note,amount:e.amount});suggestions.append(b)}
}
function render(){
 const key=month(new Date()),current=expenses.filter(e=>month(e.date)===key),spent=total(current);
 byId('heroMonth').textContent=monthLabel(key);byId('heroAmount').textContent=money(spent);byId('todayAmount').textContent=money(total(current.filter(e=>day(e.date)===today())));byId('count').textContent=String(current.length);
 byId('budgetLine').textContent=budget>0?(spent<=budget?money(budget-spent)+' left of '+money(budget)+' target':money(spent-budget)+' over '+money(budget)+' target'):'Set a monthly target in Settings';
 byId('progress').hidden=budget<=0;const progress=byId('progress').firstElementChild;progress.style.width=(budget>0?Math.min(100,spent/budget*100):0)+'%';progress.classList.toggle('over',spent>budget);
 const grouped={};current.forEach(e=>grouped[e.category]=(grouped[e.category]||0)+e.amount);const categories=Object.entries(grouped).sort((a,b)=>b[1]-a[1]);const box=byId('categories');box.replaceChildren();
 if(!categories.length)box.append(el('div','empty','No expenses this month yet.'));
 for(const [cat,value] of categories){const idx=boot.categories.indexOf(cat),color=boot.colors[idx]||'#94a3b8',row=el('div','cat'),name=el('span','',cat);name.style.color=color;row.append(name,el('strong','',money(value)));const bar=el('div','bar'),fill=el('span');fill.style.background=color;fill.style.width=(spent?value/spent*100:0)+'%';bar.append(fill);row.append(bar);box.append(row)}
 const recent=byId('recent');recent.replaceChildren();const latest=sorted(expenses).slice(0,5);if(!latest.length)recent.append(el('div','empty','No expenses logged yet. Tap + Add to start.'));else latest.forEach(e=>recent.append(expenseRow(e)));
 const months=Array.from(new Set([key,...expenses.map(e=>month(e.date))])).sort().reverse(),select=byId('monthFilter'),old=select.value;select.replaceChildren();for(const m of months){const o=el('option','',monthLabel(m));o.value=m;select.append(o)}select.value=months.includes(old)?old:key;
 const list=sorted(expenses.filter(e=>month(e.date)===select.value));byId('historySummary').textContent=list.length+' expenses · '+money(total(list));const summary=byId('historyCategories');summary.replaceChildren();const sums={};list.forEach(e=>sums[e.category]=(sums[e.category]||0)+e.amount);for(const [cat,value] of Object.entries(sums).sort((a,b)=>b[1]-a[1])){const row=el('div','cat');row.append(el('span','',cat),el('strong','',money(value)));summary.append(row)}summary.hidden=!list.length;const history=byId('historyList');history.replaceChildren();if(!list.length)history.append(el('div','empty','No expenses for this month.'));else list.forEach(e=>history.append(expenseRow(e)));
 byId('budgetInput').value=budget?budget.toFixed(2):'';
 renderSubscriptions();
}

function setCategory(category){byId('categoryInput').value=category;for(const chip of byId('categoryChips').children){const active=chip.dataset.category===category;chip.classList.toggle('active',active);chip.setAttribute('aria-pressed',String(active))}}
function syncDate(){const value=byId('dateInput').value;const label=value===today()?'Today':value?new Date(value+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'Choose date';byId('dateToggle').textContent=label+' · Change date'}
function openForm(e){editing=e&&e.id!=null?e.id:null;byId('formTitle').textContent=editing!=null?'Edit expense':'New expense';byId('saveExpense').textContent=editing!=null?'Save changes':'Save expense';byId('amountInput').value=e?String(e.amount):'';byId('noteInput').value=e?e.note:'';byId('dateInput').value=e?(e.date.length===10?e.date:day(e.date)):today();byId('dateDetails').hidden=byId('dateInput').value===today();syncDate();const selected=e&&boot.categories.includes(e.category)?e.category:preferredCategory;renderCategoryChips(selected);setCategory(selected);byId('deleteExpense').hidden=editing==null;byId('formError').textContent='';byId('overlay').classList.add('open');setTimeout(()=>byId('amountInput').focus(),150)}
function closeForm(){byId('overlay').classList.remove('open');editing=null}
function openSubForm(s){editingSub=s&&s.id!=null?s.id:null;const existing=subscriptions.find(item=>String(item.id)===String(editingSub));byId('subFormTitle').textContent=editingSub!=null?'Edit subscription':'Track subscription';byId('saveSub').textContent=editingSub!=null?'Save changes':'Save subscription';byId('subName').value=s?s.name:'';byId('subAmount').value=s?String(s.amount):'';byId('subCadence').value=s&&s.cadence?s.cadence:'';byId('subNextDate').value=s&&s.nextDate?s.nextDate:'';byId('subToggle').hidden=editingSub==null;byId('removeSub').hidden=editingSub==null;byId('subToggle').textContent=existing&&!existing.active?'Resume':'Pause';byId('subError').textContent='';byId('subOverlay').classList.add('open');setTimeout(()=>byId('subName').focus(),150)}
function closeSubForm(){byId('subOverlay').classList.remove('open');editingSub=null}
function askDelete(){const e=expenses.find(item=>String(item.id)===String(editing));if(!e)return;deletingType='delete';byId('deleteTitle').textContent='Delete this expense?';byId('deleteMessage').textContent=money(e.amount)+' · '+e.note;byId('confirmDelete').textContent='Delete expense';byId('deleteDialog').classList.add('open')}
function askSubRemove(){const s=subscriptions.find(item=>String(item.id)===String(editingSub));if(!s)return;deletingType='subscriptionRemove';byId('deleteTitle').textContent='Remove subscription?';byId('deleteMessage').textContent=s.name+' will leave your subscription list. Logged expenses stay in your history.';byId('confirmDelete').textContent='Remove subscription';byId('deleteDialog').classList.add('open')}
function closeDelete(){byId('deleteDialog').classList.remove('open')}
function toast(message){const x=byId('toast');x.textContent=message;x.style.display='block';setTimeout(()=>x.style.display='none',3500)}
const counts={};expenses.forEach(e=>counts[e.category]=(counts[e.category]||0)+1);
const recentCategory=sorted(expenses)[0]?.category;
const preferredCategory=boot.categories.includes(recentCategory)?recentCategory:boot.categories[0];
const categoryOrder=boot.categories.slice().sort((a,b)=>a===b?0:(a===preferredCategory?-1:b===preferredCategory?1:0)||(counts[b]||0)-(counts[a]||0)||boot.categories.indexOf(a)-boot.categories.indexOf(b));
function renderCategoryChips(selected){const strip=byId('categoryChips');strip.replaceChildren();for(const category of [selected,...categoryOrder.filter(c=>c!==selected)]){const chip=el('button','category-chip',category);chip.type='button';chip.dataset.category=category;chip.onclick=()=>setCategory(category);strip.append(chip)}strip.scrollLeft=0}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));byId('addTop').onclick=byId('addHistory').onclick=()=>openForm();byId('seeAll').onclick=()=>showTab('history');byId('seeSubs').onclick=()=>showTab('subscriptions');byId('addSubscription').onclick=()=>openSubForm();byId('closeSubForm').onclick=closeSubForm;byId('closeForm').onclick=closeForm;byId('monthFilter').onchange=render;
byId('dateToggle').onclick=()=>{byId('dateDetails').hidden=!byId('dateDetails').hidden;if(!byId('dateDetails').hidden)byId('dateInput').focus()};byId('dateInput').onchange=syncDate;
byId('expenseForm').onsubmit=e=>{e.preventDefault();byId('formError').textContent='';send({type:'save',id:editing,amount:byId('amountInput').value,note:byId('noteInput').value,category:byId('categoryInput').value,date:byId('dateInput').value})};
byId('subForm').onsubmit=e=>{e.preventDefault();byId('subError').textContent='';send({type:'subscriptionSave',id:editingSub,name:byId('subName').value,amount:byId('subAmount').value,cadence:byId('subCadence').value,nextDate:byId('subNextDate').value})};
byId('subToggle').onclick=()=>send({type:'subscriptionToggle',id:editingSub});byId('removeSub').onclick=askSubRemove;
byId('deleteExpense').onclick=askDelete;byId('cancelDelete').onclick=closeDelete;byId('confirmDelete').onclick=()=>{const action={type:deletingType,id:deletingType==='delete'?editing:editingSub};closeDelete();send(action)};byId('saveBudget').onclick=()=>send({type:'budget',amount:byId('budgetInput').value||'0'});byId('exportCSV').onclick=()=>send({type:'exportCSV'});byId('exportJSON').onclick=()=>send({type:'exportJSON'});byId('exportBackup').onclick=()=>send({type:'exportBackup'});
render();if(boot.initialTab!=='overview')showTab(boot.initialTab);if(boot.startAdding){openForm(boot.attempt);if(boot.status)byId('formError').textContent=boot.status}else if(boot.subscriptionAttempt){openSubForm(boot.subscriptionAttempt);if(boot.status)byId('subError').textContent=boot.status}else if(boot.status)toast(boot.status);
</script></body></html>`;
}

async function handleAction(state, action) {
  if (!action || typeof action !== "object") throw new Error("Invalid action.");
  if (action.type === "save") {
    const amount = amountFrom(action.amount);
    if (!CATEGORIES.includes(action.category)) throw new Error("Choose a category.");
    const note = String(action.note || "").trim().slice(0, 120) || action.category;
    const index = action.id == null ? -1 : state.expenses.findIndex(e => String(e.id) === String(action.id));
    if (action.id != null && index < 0) throw new Error("Expense not found. Reopen the tracker.");
    const previous = index >= 0 ? state.expenses[index] : null;
    const entry = { id: previous ? previous.id : Date.now() + "-" + Math.random(), amount, note,
      category: action.category, date: dateFor(action.date, previous && previous.date) };
    const next = state.expenses.slice();
    if (index < 0) next.push(entry); else next[index] = entry;
    await saveExpenses(next);
    state.expenses = next;
    return index < 0 ? "Expense saved" : "Expense updated";
  }
  if (action.type === "delete") {
    if (!state.expenses.some(e => String(e.id) === String(action.id))) throw new Error("Expense not found.");
    const next = state.expenses.filter(e => String(e.id) !== String(action.id));
    await saveExpenses(next);
    state.expenses = next;
    return "Expense deleted";
  }
  if (action.type === "budget") {
    const budget = amountFrom(action.amount, true);
    saveBudget(budget);
    state.budget = budget;
    return "Monthly target saved";
  }
  if (action.type === "subscriptionSave") {
    const items = state.subscriptions || [];
    const name = String(action.name || "").trim().slice(0, 120);
    if (!name) throw new Error("Enter the subscription name.");
    const amount = amountFrom(action.amount);
    if (!CADENCES.includes(action.cadence)) throw new Error("Choose how often you are billed.");
    const nextDate = dayOf(dateFor(action.nextDate));
    const index = action.id == null ? -1 : items.findIndex(item => String(item.id) === String(action.id));
    if (action.id != null && index < 0) throw new Error("Subscription not found. Reopen NOVA.");
    if (items.some((item, i) => i !== index && item.name.trim().toLowerCase() === name.toLowerCase())) {
      throw new Error("This subscription is already tracked.");
    }
    const previous = index >= 0 ? items[index] : null;
    const entry = { id: previous ? previous.id : Date.now() + "-" + Math.random(), name, amount,
      cadence: action.cadence, nextDate, active: previous ? previous.active : true };
    const next = items.slice();
    if (index < 0) next.push(entry); else next[index] = entry;
    await saveSubscriptions(next);
    state.subscriptions = next;
    return index < 0 ? "Subscription added" : "Subscription updated";
  }
  if (action.type === "subscriptionToggle") {
    const items = state.subscriptions || [];
    const index = items.findIndex(item => String(item.id) === String(action.id));
    if (index < 0) throw new Error("Subscription not found. Reopen NOVA.");
    const next = items.slice();
    next[index] = { ...next[index], active: !next[index].active };
    await saveSubscriptions(next);
    state.subscriptions = next;
    return next[index].active ? "Subscription resumed" : "Subscription paused";
  }
  if (action.type === "subscriptionRemove") {
    const items = state.subscriptions || [];
    if (!items.some(item => String(item.id) === String(action.id))) {
      throw new Error("Subscription not found. Reopen NOVA.");
    }
    const next = items.filter(item => String(item.id) !== String(action.id));
    await saveSubscriptions(next);
    state.subscriptions = next;
    return "Subscription removed";
  }
  if (action.type === "exportCSV") {
    await DocumentPicker.exportString(exportCSV(state.expenses), "spending-tracker.csv");
    return "CSV exported";
  }
  if (action.type === "exportJSON") {
    await DocumentPicker.exportString(JSON.stringify(state.expenses, null, 2), DATA_NAME);
    return "JSON exported";
  }
  if (action.type === "exportBackup") {
    const backup = { version: 1, exportedAt: new Date().toISOString(), monthlyBudget: state.budget,
      expenses: state.expenses, subscriptions: state.subscriptions || [] };
    await DocumentPicker.exportString(JSON.stringify(backup, null, 2), "NOVA-complete-backup.json");
    return "Complete backup exported";
  }
  throw new Error("Unknown action.");
}

async function showApp(state, startAdding) {
  const web = new WebView();
  const prefix = "https://scriptable-action.invalid/submit?payload=";
  let busy = false;
  web.shouldAllowRequest = request => {
    if (!request.url.startsWith(prefix)) return true;
    if (busy) return false;
    busy = true;
    let action;
    try { action = JSON.parse(decodeURIComponent(request.url.slice(prefix.length))); }
    catch (_) { action = { type: "invalid" }; }
    // Defer work until after the WebView cancels the navigation.
    Promise.resolve().then(async () => {
      let status, failed = false;
      try { status = await handleAction(state, action); }
      catch (error) { failed = true; status = String(error.message || error); }
      const type = String(action.type || "");
      const tab = type === "budget" || type.startsWith("export") ? "settings" :
        type.startsWith("subscription") ? "subscriptions" : type === "delete" ? "history" : "overview";
      try { await web.loadHTML(makeHTML(state, failed && action.type === "save", status,
        tab, failed && action.type === "save" ? action : null,
        failed && action.type === "subscriptionSave" ? action : null)); }
      catch (error) { console.error(error); }
      busy = false;
    });
    return false;
  };
  await web.loadHTML(makeHTML(state, startAdding));
  await web.present(false);
}

function widgetText(parent, value, size, color = "#FFFFFF", weight = "regular") {
  const item = parent.addText(String(value));
  item.font = weight === "bold" ? Font.boldSystemFont(size) :
    weight === "semibold" ? Font.semiboldSystemFont(size) :
    weight === "medium" ? Font.mediumSystemFont(size) : Font.systemFont(size);
  item.textColor = new Color(color);
  item.lineLimit = 1;
  item.minimumScaleFactor = 0.65;
  return item;
}

function widgetRow(parent, label, value, labelColor = "#CBD5E1", size = 11) {
  const row = parent.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  widgetText(row, label, size, labelColor);
  row.addSpacer();
  widgetText(row, value, size, "#FFFFFF", "semibold");
  return row;
}

function widgetBar(parent, segments, width = 275) {
  const height = 7;
  const drawing = new DrawContext();
  drawing.size = new Size(width, height);
  drawing.opaque = false;
  drawing.respectScreenScale = true;
  drawing.setFillColor(new Color("#293B56"));
  drawing.fillRect(new Rect(0, 0, width, height));
  let offset = 0;
  for (const segment of segments) {
    const length = Math.min(width - offset, Math.max(0, width * segment.share));
    if (length <= 0) continue;
    drawing.setFillColor(new Color(segment.color));
    drawing.fillRect(new Rect(offset, 0, length, height));
    offset += length;
  }
  const image = parent.addImage(drawing.getImage());
  image.imageSize = new Size(width, height);
  image.cornerRadius = 3;
}

function widgetWeekChart(parent, daily, labels, width = 275) {
  const drawing = new DrawContext();
  drawing.size = new Size(width, 54);
  drawing.opaque = false;
  drawing.respectScreenScale = true;
  const maximum = Math.max(1, ...daily);
  const cell = width / 7;
  for (let i = 0; i < 7; i++) {
    const height = daily[i] > 0 ? Math.max(3, 34 * daily[i] / maximum) : 2;
    drawing.setFillColor(new Color(daily[i] > 0 ? "#60A5FA" : "#34435C"));
    drawing.fillRect(new Rect(i * cell + 8, 35 - height, cell - 16, height));
    drawing.setFont(Font.mediumSystemFont(9));
    drawing.setTextColor(new Color("#94A3B8"));
    drawing.setTextAlignedCenter();
    drawing.drawTextInRect(labels[i], new Rect(i * cell, 40, cell, 12));
  }
  const image = parent.addImage(drawing.getImage());
  image.imageSize = new Size(width, 54);
}

function makeAccessoryWidget(state, error, family) {
  const widget = new ListWidget();
  widget.setPadding(0, 0, 0, 0);
  const baseURL = URLScheme.forRunningScript();
  widget.url = baseURL + (baseURL.includes("?") ? "&" : "?") + "action=add";
  widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

  if (family === "accessoryInline") {
    const now = new Date();
    const spent = error ? null : state.expenses.filter(e => monthOf(e.date) === monthOf(now))
      .reduce((sum, e) => sum + e.amount, 0);
    widgetText(widget, error ? "Open NOVA" :
      now.toLocaleDateString("en-US", { month: "short" }) + " spent " + money(spent),
      12, "#FFFFFF", "semibold");
    return widget;
  }

  if (error) {
    widget.addSpacer();
    widgetText(widget, family === "accessoryCircular" ? "!" : "Open NOVA",
      family === "accessoryCircular" ? 22 : 12, "#FFFFFF", "semibold").centerAlignText();
    widget.addSpacer();
    return widget;
  }

  const now = new Date();
  const spent = state.expenses.filter(e => monthOf(e.date) === monthOf(now))
    .reduce((sum, e) => sum + e.amount, 0);
  const today = state.expenses.filter(e => dayOf(e.date) === dayOf(now))
    .reduce((sum, e) => sum + e.amount, 0);
  if (family === "accessoryCircular") {
    widget.addSpacer();
    widgetText(widget, "TODAY", 9, "#FFFFFF", "medium").centerAlignText();
    widgetText(widget, today < 1000 ? money(today) : "$" + (today / 1000).toFixed(1) + "k",
      14, "#FFFFFF", "bold").centerAlignText();
    widget.addSpacer();
  } else {
    widgetText(widget, "NOVA · MONTH", 9, "#FFFFFF", "medium");
    widgetText(widget, money(spent), 18, "#FFFFFF", "bold");
    widget.addSpacer(2);
    widgetText(widget, "Today " + money(today), 10, "#FFFFFF", "medium");
  }
  return widget;
}

function makeWidget(state, error, family = config.widgetFamily || "medium") {
  if (["accessoryInline", "accessoryCircular", "accessoryRectangular"].includes(family)) {
    return makeAccessoryWidget(state, error, family);
  }
  const small = family === "small";
  const large = family === "large" || family === "extraLarge";
  const chartWidth = family === "extraLarge" ? 500 : 275;
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#111827");
  widget.setPadding(small ? 13 : 17, small ? 13 : 18, small ? 13 : 17, small ? 13 : 18);
  const baseURL = URLScheme.forRunningScript();
  widget.url = baseURL + (baseURL.includes("?") ? "&" : "?") + "action=add";

  const heading = widget.addStack();
  heading.layoutHorizontally();
  widgetText(heading, "NOVA", small ? 9 : 10, "#94A3B8", "semibold");
  heading.addSpacer();
  if (!small) widgetText(heading, "+ ADD", 10, "#60A5FA", "semibold");
  widget.addSpacer(8);

  if (error) {
    widgetText(widget, "Open NOVA to check iCloud data", 12, "#FFFFFF", "medium").lineLimit = 2;
    widget.addSpacer();
    return widget;
  }

  const now = new Date();
  const current = state.expenses.filter(e => monthOf(e.date) === monthOf(now));
  const spent = current.reduce((sum, e) => sum + e.amount, 0);
  const today = current.filter(e => dayOf(e.date) === dayOf(now))
    .reduce((sum, e) => sum + e.amount, 0);
  const grouped = {};
  current.forEach(e => grouped[e.category] = (grouped[e.category] || 0) + e.amount);
  const categories = Object.entries(grouped).sort((a, b) => b[1] - a[1]);
  const monthLabel = now.toLocaleDateString("en-US", { month: small ? "short" : "long", year: "numeric" });
  const remaining = state.budget - spent;
  const targetLabel = money(Math.abs(remaining)) + (remaining >= 0 ? " left of target" : " over target");
  const targetColor = remaining >= 0 ? "#34D399" : "#FB7185";
  if (small) {
    widgetText(widget, monthLabel, 10, "#94A3B8");
    widgetText(widget, money(spent), 27, "#FFFFFF", "bold");
    widget.addSpacer(6);
    widgetText(widget, "Today " + money(today), 10, "#CBD5E1", "medium");
    if (state.budget > 0) {
      widget.addSpacer(5);
      widgetText(widget, targetLabel, 9, targetColor, "medium");
    }
  } else if (!large) {
    const columns = widget.addStack();
    columns.layoutHorizontally();
    const left = columns.addStack();
    left.layoutVertically();
    widgetText(left, monthLabel, 11, "#94A3B8");
    widgetText(left, money(spent), 28, "#FFFFFF", "bold");
    left.addSpacer(5);
    widgetText(left, "Today " + money(today), 10, "#CBD5E1", "medium");
    if (state.budget > 0) widgetText(left, targetLabel, 9, targetColor, "medium");
    columns.addSpacer();
    const right = columns.addStack();
    right.layoutVertically();
    widgetText(right, "TOP CATEGORIES", 9, "#94A3B8", "semibold");
    right.addSpacer(4);
    if (!categories.length) widgetText(right, "No expenses yet", 10, "#CBD5E1");
    for (const [category, value] of categories.slice(0, 2)) {
      widgetText(right, category, 10, COLORS[CATEGORIES.indexOf(category)] || "#94A3B8");
      widgetText(right, money(value), 11, "#FFFFFF", "semibold");
    }
    widget.addSpacer(9);
    const latest = current.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
    if (latest) widgetRow(widget, "Latest · " + (latest.note || latest.category), money(latest.amount), "#94A3B8", 10);
    else widgetText(widget, "No expenses this month", 10, "#94A3B8");
  } else {
    const columns = widget.addStack();
    columns.layoutHorizontally();
    const summary = columns.addStack();
    summary.layoutVertically();
    widgetText(summary, monthLabel, 11, "#94A3B8");
    widgetText(summary, money(spent), 32, "#FFFFFF", "bold");
    summary.addSpacer(4);
    widgetText(summary, "Today " + money(today), 10, "#CBD5E1", "medium");
    if (state.budget > 0) widgetText(summary, targetLabel, 9, targetColor, "medium");
    columns.addSpacer();
    const categoryColumn = columns.addStack();
    categoryColumn.layoutVertically();
    widgetText(categoryColumn, "TOP CATEGORIES", 9, "#94A3B8", "semibold");
    categoryColumn.addSpacer(4);
    if (!categories.length) widgetText(categoryColumn, "No expenses yet", 10, "#CBD5E1");
    for (const [category, value] of categories.slice(0, 3)) {
      widgetText(categoryColumn, category, 10, COLORS[CATEGORIES.indexOf(category)] || "#94A3B8");
      widgetText(categoryColumn, money(value), 10, "#FFFFFF", "semibold");
    }
    widget.addSpacer(8);
    if (state.budget > 0) {
      widgetBar(widget, [{ share: Math.min(1, spent / state.budget), color: targetColor }], chartWidth);
    } else {
      widgetBar(widget, categories.map(([category, value]) => ({
        share: spent ? value / spent : 0,
        color: COLORS[CATEGORIES.indexOf(category)] || "#94A3B8"
      })), chartWidth);
    }

    const daily = [], labels = [];
    for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
      const day = new Date(now);
      day.setHours(12, 0, 0, 0);
      day.setDate(day.getDate() - daysAgo);
      const key = dayOf(day);
      daily.push(state.expenses.filter(e => dayOf(e.date) === key)
        .reduce((sum, e) => sum + e.amount, 0));
      labels.push(day.toLocaleDateString("en-US", { weekday: "short" }));
    }
    widget.addSpacer(9);
    widgetRow(widget, "LAST 7 DAYS", money(daily.reduce((sum, value) => sum + value, 0)), "#94A3B8", 9);
    widget.addSpacer(3);
    widgetWeekChart(widget, daily, labels, chartWidth);

    widget.addSpacer(8);
    widgetText(widget, "RECENT EXPENSES", 9, "#94A3B8", "semibold");
    widget.addSpacer(3);
    const recent = state.expenses.slice().sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, family === "extraLarge" ? 4 : 2);
    if (!recent.length) widgetText(widget, "Nothing logged yet", 11, "#CBD5E1");
    for (const entry of recent) widgetRow(widget, entry.note, money(entry.amount), "#FFFFFF", 11);
  }

  widget.addSpacer();
  const updated = "Updated " + now.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " · " + now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  widgetText(widget, small ? "Tap to add" : updated, small ? 9 : 10,
    small ? "#60A5FA" : "#94A3B8", "medium");
  widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  return widget;
}

if (config.runsInWidget) {
  try { Script.setWidget(makeWidget(await loadState(false))); }
  catch (error) { console.error(error); Script.setWidget(makeWidget(null, error)); }
} else {
  try { await showApp(await loadState(), args.queryParameters?.action === "add"); }
  catch (error) {
    const alert = new Alert(); alert.title = "NOVA";
    alert.message = "Could not open iCloud data: " + String(error.message || error) +
      "\n\nYour existing local file was not removed.";
    alert.addAction("OK"); await alert.presentAlert();
  }
}
Script.complete();
