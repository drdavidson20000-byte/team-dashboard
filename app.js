import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, setDoc,
  onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* ---------------- Firebase init ---------------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// 생성 시각(오름차순) 기준 정렬 — Firestore 복합 색인(composite index) 없이
// where() 단일 조건만 서버에 보내고, 정렬은 클라이언트에서 처리합니다.
function sortByCreatedAt(arr){
  return arr.slice().sort((a, b) => {
    const at = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
    const bt = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
    return at - bt;
  });
}

/* layer3(상세설명) 문서 id는 "항목(l2) + 주차"로 고정해, 한 항목당 그 주에 하나의
   상세설명만 존재하도록 합니다(엑셀 표의 한 셀과 동일한 개념). */
function l3DocId(l2Id, week){
  return `${l2Id}__${week}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/* =====================================================================
   상태 (State)
   ===================================================================== */
const state = {
  team: "planning",           // "planning" | "management"
  weekOffset: 0,               // 0 = 이번 주
  l1: [],                      // [{id, team, name, createdAt}]  -- 분류(프로젝트)
  l2: [],                      // [{id, team, l1Id, name, createdAt}] -- 항목
  l3: [],                      // [{id(=l2Id__week), team, l2Id, week, content, author, updatedAt}] -- 상세설명
  editingKey: null,            // 현재 인라인 편집 중인 l2Id
  fetchError: null,
};

let unsubL1 = null, unsubL2 = null, unsubL3 = null;

/* =====================================================================
   ISO 주차 유틸
   ===================================================================== */
function getISOWeekInfo(date){
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const weekNum = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return { year: d.getUTCFullYear(), week: weekNum };
}
function mondayOfWeek(year, week){
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}
function weekKeyFromOffset(offset){
  const base = new Date();
  base.setDate(base.getDate() + offset * 7);
  const { year, week } = getISOWeekInfo(base);
  return `${year}-W${String(week).padStart(2,"0")}`;
}
function formatWeekLabel(weekKey){
  const [yearStr, wStr] = weekKey.split("-W");
  const year = parseInt(yearStr, 10), week = parseInt(wStr, 10);
  const monday = mondayOfWeek(year, week);
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (d) => `${d.getUTCMonth()+1}월 ${d.getUTCDate()}일`;
  return {
    label: `${year}년 ${week}주차`,
    range: `${fmt(monday)} ~ ${fmt(sunday)}`
  };
}
function currentWeekKey(){ return weekKeyFromOffset(state.weekOffset); }

/* =====================================================================
   로그인 (Firebase Authentication)
   ===================================================================== */
const loginScreen = document.getElementById("login-screen");
const appRoot = document.getElementById("app");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const userEmailEl = document.getElementById("user-email");

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    loginError.textContent = "로그인 실패: 이메일 또는 비밀번호를 확인하세요.";
    console.error(err);
  }
});

document.getElementById("logout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  if (user) {
    loginScreen.style.display = "none";
    appRoot.style.display = "block";
    userEmailEl.textContent = user.email || "";
    initApp();
  } else {
    loginScreen.style.display = "flex";
    appRoot.style.display = "none";
    if (unsubL1) { unsubL1(); unsubL1 = null; }
    if (unsubL2) { unsubL2(); unsubL2 = null; }
    if (unsubL3) { unsubL3(); unsubL3 = null; }
    state.l1 = []; state.l2 = []; state.l3 = [];
  }
});

/* =====================================================================
   앱 초기화 / 탭 전환
   ===================================================================== */
let appInitialized = false;
function initApp(){
  if (appInitialized) { renderWeekBar(); subscribeTeamData(); return; }
  appInitialized = true;

  document.querySelectorAll(".team-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".team-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.team = tab.dataset.team;
      state.editingKey = null;
      subscribeTeamData();
    });
  });

  document.getElementById("week-prev").addEventListener("click", () => { state.weekOffset--; state.editingKey = null; renderWeekBar(); renderTable(); });
  document.getElementById("week-next").addEventListener("click", () => { state.weekOffset++; state.editingKey = null; renderWeekBar(); renderTable(); });
  document.getElementById("week-today").addEventListener("click", () => { state.weekOffset = 0; state.editingKey = null; renderWeekBar(); renderTable(); });

  document.getElementById("add-l1-btn").addEventListener("click", () => promptAddL1());
  document.getElementById("import-week-btn").addEventListener("click", () => importPreviousWeekBulk());

  renderWeekBar();
  subscribeTeamData();
}

function renderWeekBar(){
  const key = currentWeekKey();
  const { label, range } = formatWeekLabel(key);
  document.getElementById("week-label").textContent = label;
  document.getElementById("week-range").textContent = range;
}

/* =====================================================================
   Firestore 구독
   ===================================================================== */
function subscribeTeamData(){
  if (unsubL1) unsubL1();
  if (unsubL2) unsubL2();
  if (unsubL3) unsubL3();
  state.l1 = []; state.l2 = []; state.l3 = [];
  state.editingKey = null;
  state.fetchError = null;
  renderTable();

  const team = state.team;
  const onErr = (label) => (err) => {
    console.error(label + " 구독 오류", err);
    state.fetchError = "Firestore 연결에 실패했습니다. firebase-config.js 값과 firestore.rules 배포 상태를 확인하세요.";
    const statusEl = document.getElementById("sync-status");
    if (statusEl) statusEl.textContent = "⚠ 연결 오류";
    renderTable();
  };

  const q1 = query(collection(db, "layer1"), where("team", "==", team));
  unsubL1 = onSnapshot(q1, snap => {
    state.l1 = sortByCreatedAt(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderTable();
  }, onErr("layer1"));

  const q2 = query(collection(db, "layer2"), where("team", "==", team));
  unsubL2 = onSnapshot(q2, snap => {
    state.l2 = sortByCreatedAt(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderTable();
  }, onErr("layer2"));

  const q3 = query(collection(db, "layer3"), where("team", "==", team));
  unsubL3 = onSnapshot(q3, snap => {
    state.l3 = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderTable();
  }, onErr("layer3"));
}

/* =====================================================================
   CRUD 헬퍼
   ===================================================================== */
async function addL1(name){
  await addDoc(collection(db, "layer1"), { team: state.team, name, createdAt: serverTimestamp() });
}
async function renameL1(id, name){ await updateDoc(doc(db, "layer1", id), { name }); }
async function deleteL1(id){
  const children = state.l2.filter(x => x.l1Id === id);
  for (const c of children) await deleteL2(c.id);
  await deleteDoc(doc(db, "layer1", id));
}
async function addL2(l1Id, name){
  await addDoc(collection(db, "layer2"), { team: state.team, l1Id, name, createdAt: serverTimestamp() });
}
async function renameL2(id, name){ await updateDoc(doc(db, "layer2", id), { name }); }
async function deleteL2(id){
  const relatedEntries = state.l3.filter(x => x.l2Id === id);
  for (const e of relatedEntries) await deleteDoc(doc(db, "layer3", e.id));
  await deleteDoc(doc(db, "layer2", id));
}
/* 상세설명은 "항목 + 주차" 하나당 하나의 문서로 upsert 합니다. */
async function saveL3(l2Id, week, content, author){
  const id = l3DocId(l2Id, week);
  await setDoc(doc(db, "layer3", id), {
    team: state.team, l2Id, week,
    content, author: author || "",
    updatedAt: serverTimestamp()
  });
}
async function clearL3(l2Id, week){
  const id = l3DocId(l2Id, week);
  await deleteDoc(doc(db, "layer3", id));
}

/* 지난 주 상세설명을 이번 주 빈 항목에 한번에 채워 넣습니다(이미 작성된 항목은 건드리지 않음). */
async function importPreviousWeekBulk(){
  const prevKey = weekKeyFromOffset(state.weekOffset - 1);
  const curKey = currentWeekKey();

  const candidates = [];
  state.l2.forEach(l2 => {
    const prevEntry = state.l3.find(x => x.id === l3DocId(l2.id, prevKey));
    const curEntry = state.l3.find(x => x.id === l3DocId(l2.id, curKey));
    if (prevEntry && prevEntry.content && (!curEntry || !curEntry.content)) {
      candidates.push({ l2Id: l2.id, content: prevEntry.content, author: prevEntry.author });
    }
  });

  if (candidates.length === 0) {
    alert("가져올 내용이 없습니다. (지난 주에 작성된 내용이 없거나, 이번 주 항목에 이미 내용이 채워져 있습니다.)");
    return;
  }
  if (!confirm(`빈 항목 ${candidates.length}건에 지난 주 상세설명을 채워 넣을까요? (이미 작성된 항목은 그대로 유지됩니다)`)) return;

  for (const c of candidates) {
    await saveL3(c.l2Id, curKey, c.content, c.author);
  }
}

/* =====================================================================
   렌더링 — 단일 표 (분류 / 항목 / 상세설명), 분류는 세로 병합
   ===================================================================== */
const statusBanner = document.getElementById("status-banner");
const tableWrap = document.getElementById("table-wrap");
const tbody = document.getElementById("report-tbody");

function renderTable(){
  if (state.fetchError) {
    statusBanner.textContent = state.fetchError;
    statusBanner.hidden = false;
    tableWrap.hidden = true;
    return;
  }
  statusBanner.hidden = true;
  tableWrap.hidden = false;

  tbody.innerHTML = "";

  if (state.l1.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.appendChild(emptyHint("등록된 프로젝트(분류)가 없습니다. 위 '+ 프로젝트 추가' 버튼으로 시작하세요."));
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const weekKey = currentWeekKey();

  state.l1.forEach(l1 => {
    const children = state.l2.filter(x => x.l1Id === l1.id);

    if (children.length === 0) {
      const tr = document.createElement("tr");
      tr.appendChild(buildL1Cell(l1, 1));
      const td = document.createElement("td");
      td.colSpan = 2;
      td.className = "l2-cell empty-l2-cell";
      const hint = document.createElement("span");
      hint.className = "muted-text";
      hint.textContent = "항목이 없습니다.";
      const addBtn = document.createElement("button");
      addBtn.className = "inline-add-btn";
      addBtn.textContent = "+ 항목 추가";
      addBtn.addEventListener("click", () => promptAddL2(l1.id));
      td.appendChild(hint);
      td.appendChild(addBtn);
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    children.forEach((l2, idx) => {
      const tr = document.createElement("tr");
      if (idx === 0) tr.appendChild(buildL1Cell(l1, children.length));
      tr.appendChild(buildL2Cell(l2, l1));
      tr.appendChild(buildL3Cell(l2, weekKey));
      tbody.appendChild(tr);
    });
  });
}

function emptyHint(text){
  const div = document.createElement("div");
  div.className = "empty-hint";
  div.textContent = text;
  return div;
}

function buildL1Cell(l1, rowspan){
  const td = document.createElement("td");
  td.className = "l1-cell";
  td.rowSpan = rowspan;

  const name = document.createElement("div");
  name.className = "l1-name";
  name.textContent = l1.name;
  td.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "l1-actions";
  actions.innerHTML = `
    <button class="icon-btn" data-act="add">+ 항목</button>
    <button class="icon-btn" data-act="edit">편집</button>
    <button class="icon-btn danger" data-act="del">삭제</button>
  `;
  actions.querySelector('[data-act="add"]').addEventListener("click", () => promptAddL2(l1.id));
  actions.querySelector('[data-act="edit"]').addEventListener("click", () => {
    const next = prompt("프로젝트명 수정", l1.name);
    if (next && next.trim()) renameL1(l1.id, next.trim());
  });
  actions.querySelector('[data-act="del"]').addEventListener("click", () => {
    if (confirm(`"${l1.name}" 프로젝트와 하위 항목/상세설명을 모두 삭제할까요?`)) deleteL1(l1.id);
  });
  td.appendChild(actions);
  return td;
}

function buildL2Cell(l2){
  const td = document.createElement("td");
  td.className = "l2-cell";

  const name = document.createElement("div");
  name.className = "l2-name";
  name.textContent = l2.name;
  td.appendChild(name);

  const actions = document.createElement("div");
  actions.className = "l2-actions";
  actions.innerHTML = `
    <button class="icon-btn" data-act="edit">편집</button>
    <button class="icon-btn danger" data-act="del">삭제</button>
  `;
  actions.querySelector('[data-act="edit"]').addEventListener("click", () => {
    const next = prompt("항목명 수정", l2.name);
    if (next && next.trim()) renameL2(l2.id, next.trim());
  });
  actions.querySelector('[data-act="del"]').addEventListener("click", () => {
    if (confirm(`"${l2.name}" 항목과 모든 주차의 상세설명을 삭제할까요?`)) deleteL2(l2.id);
  });
  td.appendChild(actions);
  return td;
}

function buildL3Cell(l2, weekKey){
  const td = document.createElement("td");
  td.className = "l3-cell";

  const entry = state.l3.find(x => x.id === l3DocId(l2.id, weekKey));

  if (state.editingKey === l2.id) {
    renderL3EditMode(td, l2, weekKey, entry);
  } else {
    renderL3ViewMode(td, l2, weekKey, entry);
  }
  return td;
}

function renderL3ViewMode(td, l2, weekKey, entry){
  if (entry && entry.content) {
    const text = document.createElement("div");
    text.className = "detail-text";
    text.textContent = entry.content;
    text.addEventListener("click", () => { state.editingKey = l2.id; renderTable(); });
    td.appendChild(text);

    const meta = document.createElement("div");
    meta.className = "detail-meta";
    const when = entry.updatedAt && entry.updatedAt.toDate ? entry.updatedAt.toDate() : null;
    const whenStr = when ? `${when.getMonth()+1}/${when.getDate()} ${String(when.getHours()).padStart(2,"0")}:${String(when.getMinutes()).padStart(2,"0")}` : "";
    meta.innerHTML = `
      <span>${entry.author ? escapeHtml(entry.author) : "작성자 미상"}</span>
      <span>${whenStr}</span>
      <span class="spacer"></span>
      <button class="icon-btn" data-act="edit">편집</button>
      <button class="icon-btn danger" data-act="del">삭제</button>
    `;
    meta.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
      e.stopPropagation();
      state.editingKey = l2.id;
      renderTable();
    });
    meta.querySelector('[data-act="del"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm("이번 주 상세설명을 삭제할까요?")) await clearL3(l2.id, weekKey);
    });
    td.appendChild(meta);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "detail-placeholder";
    placeholder.textContent = "클릭해서 작성";
    placeholder.addEventListener("click", () => { state.editingKey = l2.id; renderTable(); });
    td.appendChild(placeholder);
  }
}

function renderL3EditMode(td, l2, weekKey, entry){
  const form = document.createElement("div");
  form.className = "inline-form l3-edit-form";
  form.innerHTML = `
    <input type="text" placeholder="작성자 (선택)" class="author-input">
    <textarea placeholder="상세설명을 입력하세요..."></textarea>
    <div class="row">
      <button class="btn-sm save">저장</button>
      <button class="btn-sm cancel">취소</button>
    </div>
  `;
  const textarea = form.querySelector("textarea");
  const authorInput = form.querySelector(".author-input");
  textarea.value = entry ? (entry.content || "") : "";
  authorInput.value = entry ? (entry.author || "") : "";
  td.appendChild(form);
  textarea.focus();

  form.querySelector(".save").addEventListener("click", async () => {
    const content = textarea.value.trim();
    const author = authorInput.value.trim();
    if (!content) { textarea.focus(); return; }
    await saveL3(l2.id, weekKey, content, author);
    state.editingKey = null;
    renderTable();
  });
  form.querySelector(".cancel").addEventListener("click", () => {
    state.editingKey = null;
    renderTable();
  });
}

function escapeHtml(s){
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

/* ---- prompts ---- */
function promptAddL1(){
  const name = prompt("새 프로젝트명 (예: GMCS project)");
  if (name && name.trim()) addL1(name.trim());
}
function promptAddL2(l1Id){
  const name = prompt("새 항목명 (예: 기획, 대시보드)");
  if (name && name.trim()) addL2(l1Id, name.trim());
}
