import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc, setDoc,
  onSnapshot, getDocs, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

/* ---------------- Firebase init ---------------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* =====================================================================
   설계 메모
   -----------------------------------------------------------------------
   각 주(week)는 완전히 독립된 데이터입니다. 분류(layer1)/항목(layer2)/
   상세설명(layer3) 모두 team + week로 스코프되어 있어서, 어떤 주에 분류나
   항목을 추가/수정해도 다른 주에는 전혀 영향을 주지 않습니다. 새로운 주로
   이동하면 기본적으로 빈 상태이고, 사용자가 "지난 주 내용 가져오기"를 눌러야만
   그 시점의 지난 주 스냅샷이 통째로 복사되어 이번 주의 새 문서로 생성됩니다
   (원본은 그대로 유지 — 이후 이번 주에서 수정해도 지난 주 데이터는 바뀌지 않음).
   ===================================================================== */

// 생성 시각(오름차순) 기준 정렬 — Firestore 복합 색인(composite index) 없이
// where() 단일/복수 등호 조건만 서버에 보내고, 정렬은 클라이언트에서 처리합니다.
function sortByCreatedAt(arr){
  return arr.slice().sort((a, b) => {
    const at = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
    const bt = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
    return at - bt;
  });
}

/* =====================================================================
   상태 (State)
   ===================================================================== */
const state = {
  team: "planning",           // "planning" | "management"
  weekOffset: 0,               // 0 = 이번 주
  l1: [],                      // [{id, team, week, name, createdAt}]  -- 분류(프로젝트), 그 주 한정
  l2: [],                      // [{id, team, week, l1Id, name, createdAt}] -- 항목, 그 주 한정
  l3: [],                      // [{id(=l2Id), team, week, l2Id, content, author, updatedAt}] -- 상세설명
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
    unsubscribeAll();
    state.l1 = []; state.l2 = []; state.l3 = [];
  }
});

function unsubscribeAll(){
  if (unsubL1) { unsubL1(); unsubL1 = null; }
  if (unsubL2) { unsubL2(); unsubL2 = null; }
  if (unsubL3) { unsubL3(); unsubL3 = null; }
}

/* =====================================================================
   앱 초기화 / 탭 전환
   ===================================================================== */
let appInitialized = false;
function initApp(){
  if (appInitialized) { renderWeekBar(); subscribeWeekData(); return; }
  appInitialized = true;

  document.querySelectorAll(".team-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".team-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.team = tab.dataset.team;
      state.editingKey = null;
      subscribeWeekData();
    });
  });

  document.getElementById("week-prev").addEventListener("click", () => { state.weekOffset--; state.editingKey = null; renderWeekBar(); subscribeWeekData(); });
  document.getElementById("week-next").addEventListener("click", () => { state.weekOffset++; state.editingKey = null; renderWeekBar(); subscribeWeekData(); });
  document.getElementById("week-today").addEventListener("click", () => { state.weekOffset = 0; state.editingKey = null; renderWeekBar(); subscribeWeekData(); });

  document.getElementById("add-l1-btn").addEventListener("click", () => promptAddL1());
  document.getElementById("import-week-btn").addEventListener("click", () => importPreviousWeekFull());
  document.getElementById("export-excel-btn").addEventListener("click", () => exportToExcel());

  renderWeekBar();
  subscribeWeekData();
}

function renderWeekBar(){
  const key = currentWeekKey();
  const { label, range } = formatWeekLabel(key);
  document.getElementById("week-label").textContent = label;
  document.getElementById("week-range").textContent = range;
}

/* =====================================================================
   Firestore 구독 — team + week 로 스코프 (다른 주와 완전히 분리됨)
   ===================================================================== */
function subscribeWeekData(){
  unsubscribeAll();
  state.l1 = []; state.l2 = []; state.l3 = [];
  state.fetchError = null;
  renderTable();

  const team = state.team;
  const week = currentWeekKey();

  const onErr = (label) => (err) => {
    console.error(label + " 구독 오류", err);
    state.fetchError = "Firestore 연결에 실패했습니다. firebase-config.js 값과 firestore.rules 배포 상태를 확인하세요.";
    const statusEl = document.getElementById("sync-status");
    if (statusEl) statusEl.textContent = "⚠ 연결 오류";
    renderTable();
  };

  const q1 = query(collection(db, "layer1"), where("team", "==", team), where("week", "==", week));
  unsubL1 = onSnapshot(q1, snap => {
    state.l1 = sortByCreatedAt(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderTable();
  }, onErr("layer1"));

  const q2 = query(collection(db, "layer2"), where("team", "==", team), where("week", "==", week));
  unsubL2 = onSnapshot(q2, snap => {
    state.l2 = sortByCreatedAt(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderTable();
  }, onErr("layer2"));

  const q3 = query(collection(db, "layer3"), where("team", "==", team), where("week", "==", week));
  unsubL3 = onSnapshot(q3, snap => {
    state.l3 = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderTable();
  }, onErr("layer3"));
}

/* =====================================================================
   CRUD 헬퍼 (모두 현재 team + 현재 week 범위 안에서만 동작)
   ===================================================================== */
async function addL1(name){
  await addDoc(collection(db, "layer1"), { team: state.team, week: currentWeekKey(), name, createdAt: serverTimestamp() });
}
async function renameL1(id, name){ await updateDoc(doc(db, "layer1", id), { name }); }
async function deleteL1(id){
  const children = state.l2.filter(x => x.l1Id === id);
  for (const c of children) await deleteL2(c.id);
  await deleteDoc(doc(db, "layer1", id));
}
async function addL2(l1Id, name){
  await addDoc(collection(db, "layer2"), { team: state.team, week: currentWeekKey(), l1Id, name, createdAt: serverTimestamp() });
}
async function renameL2(id, name){ await updateDoc(doc(db, "layer2", id), { name }); }
async function deleteL2(id){
  const entry = state.l3.find(x => x.l2Id === id);
  if (entry) await deleteDoc(doc(db, "layer3", entry.id));
  await deleteDoc(doc(db, "layer2", id));
}
/* 상세설명은 항목(l2) 하나당 하나의 문서로 upsert 합니다(문서 id = l2Id). */
async function saveL3(l2Id, content, author){
  await setDoc(doc(db, "layer3", l2Id), {
    team: state.team, week: currentWeekKey(), l2Id,
    content, author: author || "",
    updatedAt: serverTimestamp()
  });
}
async function clearL3(l2Id){
  await deleteDoc(doc(db, "layer3", l2Id));
}

/* =====================================================================
   지난 주 전체(분류+항목+상세설명) 가져오기
   — 명시적으로 이 버튼을 눌러야만 복사되며, 완전히 새 문서로 만들어지므로
     이후 이번 주에서 수정해도 지난 주 원본은 전혀 바뀌지 않습니다.
   ===================================================================== */
async function fetchWeekSnapshot(team, week){
  const q1 = query(collection(db, "layer1"), where("team", "==", team), where("week", "==", week));
  const q2 = query(collection(db, "layer2"), where("team", "==", team), where("week", "==", week));
  const q3 = query(collection(db, "layer3"), where("team", "==", team), where("week", "==", week));
  const [s1, s2, s3] = await Promise.all([getDocs(q1), getDocs(q2), getDocs(q3)]);
  return {
    l1: s1.docs.map(d => ({ id: d.id, ...d.data() })),
    l2: s2.docs.map(d => ({ id: d.id, ...d.data() })),
    l3: s3.docs.map(d => ({ id: d.id, ...d.data() })),
  };
}

async function importPreviousWeekFull(){
  const importBtn = document.getElementById("import-week-btn");
  const prevWeek = weekKeyFromOffset(state.weekOffset - 1);
  const curWeek = currentWeekKey();

  importBtn.disabled = true;
  let prevData;
  try {
    prevData = await fetchWeekSnapshot(state.team, prevWeek);
  } finally {
    importBtn.disabled = false;
  }

  if (prevData.l1.length === 0) {
    alert(`지난 주(${prevWeek})에 작성된 내용이 없습니다.`);
    return;
  }

  const writtenCount = prevData.l3.filter(x => x.content).length;
  let msg = `지난 주(${prevWeek}) 내용을 이번 주로 복사합니다.\n분류 ${prevData.l1.length}개 · 항목 ${prevData.l2.length}개 · 작성된 상세설명 ${writtenCount}건`;
  if (state.l1.length > 0) {
    msg += `\n\n⚠ 이번 주에는 이미 작성된 분류/항목이 있습니다. 지난 주 내용이 별도로 추가 복사되며, 기존 내용은 삭제되지 않습니다.`;
  }
  msg += `\n\n계속할까요?`;
  if (!confirm(msg)) return;

  const l1IdMap = {};
  for (const l1 of prevData.l1) {
    const ref = await addDoc(collection(db, "layer1"), { team: state.team, week: curWeek, name: l1.name, createdAt: serverTimestamp() });
    l1IdMap[l1.id] = ref.id;
  }
  const l2IdMap = {};
  for (const l2 of prevData.l2) {
    const newL1Id = l1IdMap[l2.l1Id];
    if (!newL1Id) continue;
    const ref = await addDoc(collection(db, "layer2"), { team: state.team, week: curWeek, l1Id: newL1Id, name: l2.name, createdAt: serverTimestamp() });
    l2IdMap[l2.id] = ref.id;
  }
  for (const l3 of prevData.l3) {
    const newL2Id = l2IdMap[l3.l2Id];
    if (!newL2Id || !l3.content) continue;
    await setDoc(doc(db, "layer3", newL2Id), {
      team: state.team, week: curWeek, l2Id: newL2Id,
      content: l3.content, author: l3.author || "",
      updatedAt: serverTimestamp()
    });
  }
}

/* =====================================================================
   엑셀로 내보내기 — 현재 팀의 전체 주차를 각각 별도 시트로 저장
   ===================================================================== */
async function exportToExcel(){
  const exportBtn = document.getElementById("export-excel-btn");
  const teamLabel = state.team === "planning" ? "영업기획팀" : "영업관리팀";
  const originalLabel = exportBtn.textContent;
  exportBtn.disabled = true;
  exportBtn.textContent = "내보내는 중...";

  try {
    if (typeof XLSX === "undefined") {
      alert("엑셀 내보내기 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침 후 다시 시도하세요.");
      return;
    }

    const q1 = query(collection(db, "layer1"), where("team", "==", state.team));
    const q2 = query(collection(db, "layer2"), where("team", "==", state.team));
    const q3 = query(collection(db, "layer3"), where("team", "==", state.team));
    const [s1, s2, s3] = await Promise.all([getDocs(q1), getDocs(q2), getDocs(q3)]);
    const allL1 = s1.docs.map(d => ({ id: d.id, ...d.data() }));
    const allL2 = s2.docs.map(d => ({ id: d.id, ...d.data() }));
    const allL3 = s3.docs.map(d => ({ id: d.id, ...d.data() }));

    const weeks = Array.from(new Set(allL1.map(x => x.week))).sort();
    if (weeks.length === 0) {
      alert("내보낼 데이터가 없습니다.");
      return;
    }

    const wb = XLSX.utils.book_new();
    const usedSheetNames = new Set();

    weeks.forEach(week => {
      const weekL1 = sortByCreatedAt(allL1.filter(x => x.week === week));
      const rows = [["분류", "항목", "상세설명"]];
      const merges = [];

      weekL1.forEach(l1 => {
        const children = sortByCreatedAt(allL2.filter(x => x.l1Id === l1.id && x.week === week));
        const startRow = rows.length; // 0-indexed, header가 0행
        if (children.length === 0) {
          rows.push([l1.name, "", ""]);
        } else {
          children.forEach((l2, idx) => {
            const entry = allL3.find(x => x.l2Id === l2.id);
            rows.push([idx === 0 ? l1.name : "", l2.name, entry ? entry.content : ""]);
          });
          if (children.length > 1) {
            merges.push({ s: { r: startRow, c: 0 }, e: { r: startRow + children.length - 1, c: 0 } });
          }
        }
      });

      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!merges"] = merges;
      ws["!cols"] = [{ wch: 22 }, { wch: 22 }, { wch: 55 }];

      let sheetName = week.replace(/[\[\]\*\/\\\?:]/g, "-").slice(0, 31);
      let uniqueName = sheetName, n = 2;
      while (usedSheetNames.has(uniqueName)) { uniqueName = `${sheetName.slice(0, 28)}_${n++}`; }
      usedSheetNames.add(uniqueName);

      XLSX.utils.book_append_sheet(wb, ws, uniqueName);
    });

    const today = new Date();
    const dateStr = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,"0")}${String(today.getDate()).padStart(2,"0")}`;
    XLSX.writeFile(wb, `주간보고_${teamLabel}_${dateStr}.xlsx`);
  } catch (err) {
    console.error(err);
    alert("엑셀 내보내기 중 오류가 발생했습니다: " + err.message);
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = originalLabel;
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
    td.appendChild(emptyHint("이번 주에 등록된 분류가 없습니다. 위 '+ 프로젝트 추가'로 새로 시작하거나, '지난 주 내용 가져오기'로 이어서 작성하세요."));
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

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
      tr.appendChild(buildL2Cell(l2));
      tr.appendChild(buildL3Cell(l2));
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
    if (confirm(`"${l1.name}" 분류와 하위 항목/상세설명을 모두 삭제할까요? (이번 주 데이터만 삭제되며, 지난 주 기록은 영향받지 않습니다)`)) deleteL1(l1.id);
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
    if (confirm(`"${l2.name}" 항목과 이번 주 상세설명을 삭제할까요?`)) deleteL2(l2.id);
  });
  td.appendChild(actions);
  return td;
}

function buildL3Cell(l2){
  const td = document.createElement("td");
  td.className = "l3-cell";

  const entry = state.l3.find(x => x.l2Id === l2.id);

  if (state.editingKey === l2.id) {
    renderL3EditMode(td, l2, entry);
  } else {
    renderL3ViewMode(td, l2, entry);
  }
  return td;
}

function renderL3ViewMode(td, l2, entry){
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
      if (confirm("이번 주 상세설명을 삭제할까요?")) await clearL3(l2.id);
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

function renderL3EditMode(td, l2, entry){
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
    await saveL3(l2.id, content, author);
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
