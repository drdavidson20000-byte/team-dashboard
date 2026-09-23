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

/* layer3(항목별 상세) 문서에서 금주/차주/담당자 값을 읽습니다.
   예전 버전(단일 "상세설명" 칸)에서 만들어진 문서는 content/author 필드만
   가지고 있을 수 있어, thisWeek/assignee가 없으면 그 값으로 대체합니다. */
function getL3Fields(entry){
  if (!entry) return { thisWeek: "", nextWeek: "", assignee: "" };
  return {
    thisWeek: entry.thisWeek !== undefined ? entry.thisWeek : (entry.content || ""),
    nextWeek: entry.nextWeek || "",
    assignee: entry.assignee !== undefined ? entry.assignee : (entry.author || ""),
  };
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

  // ---- 지시사항 탭 ----
  activeMainTab: "weekly",     // "weekly" | "directives" | "performance" | "restaurants" | "checklist"
  directives: [],              // [{id, instructionDate, dueDate, content, team, assignee, status, createdAt}]
  directivesFetchError: null,
  directivesFilter: { team: "all", status: "all", q: "" },
  directivesSort: { field: null, dir: "asc" }, // field=null → 기본(진행중 우선 + 지시날짜 내림차순) 정렬
  directiveModalMode: null,    // "add" | "edit" | null
  directiveEditingId: null,

  // ---- 식당 탭 ----
  restaurants: [],             // [{id, name, category, location, memo, author, images:[dataURL...], createdAt}]
  restaurantsFetchError: null,
  restaurantFilter: { category: "all", location: "all", q: "" },
  restaurantModalMode: null,   // "add" | "edit" | null
  restaurantEditingId: null,

  // ---- 운영체크리스트 탭 ----
  checklistProjects: [],       // [{id, name, createdAt}]
  checklistActiveProjectId: null,
  checklistItems: [],          // 현재 선택된 프로젝트의 항목들 [{id, projectId, category, no, item, content, note, done, assignee, createdAt}]
  checklistItemsFetchError: null,
  checklistItemModalMode: null, // "add" | "edit" | null
  checklistItemEditingId: null,
};

let unsubL1 = null, unsubL2 = null, unsubL3 = null;
let unsubDirectives = null;
let unsubRestaurants = null;
let unsubChecklistProjects = null;
let unsubChecklistItems = null;
let pendingRestaurantImages = []; // 식당 추가/편집 폼이 열려 있는 동안만 쓰는 임시 사진 목록(dataURL)

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
    state.directives = [];
    state.restaurants = [];
    state.checklistProjects = [];
    state.checklistItems = [];
    state.checklistActiveProjectId = null;
  }
});

function unsubscribeWeeklyListeners(){
  if (unsubL1) { unsubL1(); unsubL1 = null; }
  if (unsubL2) { unsubL2(); unsubL2 = null; }
  if (unsubL3) { unsubL3(); unsubL3 = null; }
}

function unsubscribeAll(){
  unsubscribeWeeklyListeners();
  if (unsubDirectives) { unsubDirectives(); unsubDirectives = null; }
  if (unsubRestaurants) { unsubRestaurants(); unsubRestaurants = null; }
  if (unsubChecklistProjects) { unsubChecklistProjects(); unsubChecklistProjects = null; }
  if (unsubChecklistItems) { unsubChecklistItems(); unsubChecklistItems = null; }
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

  initMainTabs();
  initDirectivesTab();
  subscribeDirectives();
  initColumnResize();
  initPerformanceTab();
  initRestaurantsTab();
  subscribeRestaurants();
  initChecklistTab();
  subscribeChecklistProjects();
}

/* =====================================================================
   주간보고 표 — 열 너비를 드래그로 직접 조절 (이 브라우저에 저장되어
   다음에 열어도 유지됩니다. 다른 팀원의 화면에는 영향을 주지 않습니다.)
   ===================================================================== */
const COL_WIDTH_STORAGE_KEY = "weeklyReportColWidths";
const DEFAULT_COL_WIDTHS = { l1: 150, l2: 150, thisweek: 280, nextweek: 280, assignee: 120 };
const MIN_COL_WIDTH = 70;

function loadColumnWidths(){
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(COL_WIDTH_STORAGE_KEY) || "{}");
  } catch (e) {
    saved = {};
  }
  return { ...DEFAULT_COL_WIDTHS, ...saved };
}

function saveColumnWidths(widths){
  try {
    localStorage.setItem(COL_WIDTH_STORAGE_KEY, JSON.stringify(widths));
  } catch (e) {
    // localStorage를 쓸 수 없는 환경(사생활 보호 모드 등)이면 조용히 무시합니다.
  }
}

function applyColumnWidths(widths){
  document.querySelectorAll("#report-table colgroup col").forEach(col => {
    const key = col.dataset.col;
    if (widths[key]) col.style.width = widths[key] + "px";
  });
}

function initColumnResize(){
  const table = document.getElementById("report-table");
  if (!table) return;

  applyColumnWidths(loadColumnWidths());

  table.querySelectorAll(".col-resize-handle").forEach(handle => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const key = handle.dataset.col;
      const col = table.querySelector(`colgroup col[data-col="${key}"]`);
      if (!col) return;

      const startX = e.clientX;
      const startWidth = parseInt(col.style.width, 10) || DEFAULT_COL_WIDTHS[key] || 150;
      handle.classList.add("resizing");
      table.classList.add("col-resizing");

      const onMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        col.style.width = Math.max(MIN_COL_WIDTH, startWidth + delta) + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        handle.classList.remove("resizing");
        table.classList.remove("col-resizing");
        const widths = loadColumnWidths();
        widths[key] = parseInt(col.style.width, 10);
        saveColumnWidths(widths);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

/* =====================================================================
   상단 메인 탭 전환 (주간보고 / 지시사항 / 성과관리)
   ===================================================================== */
function initMainTabs(){
  document.querySelectorAll(".main-tab").forEach(tab => {
    if (tab.classList.contains("disabled")) return;
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      if (!target || target === state.activeMainTab) return;
      state.activeMainTab = target;
      document.querySelectorAll(".main-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-panel-weekly").hidden = target !== "weekly";
      document.getElementById("tab-panel-directives").hidden = target !== "directives";
      document.getElementById("tab-panel-performance").hidden = target !== "performance";
      document.getElementById("tab-panel-restaurants").hidden = target !== "restaurants";
      document.getElementById("tab-panel-checklist").hidden = target !== "checklist";
    });
  });
}

/* =====================================================================
   성과관리 표 — 열 그룹(산출식 / 측정 방법 / 평가 기준 / 보조 지표) 숨기기·보이기.
   순수 정적 참고용 표라 Firestore에 저장하지 않고, 어떤 열을 숨겼는지만
   이 브라우저에 저장해 다음에 다시 열어도 유지되도록 합니다.
   ===================================================================== */
const PERF_HIDE_STORAGE_KEY = "perfTableHiddenGroups";
const PERF_HIDE_GROUPS = ["formula", "method", "criteria", "aux"];

function loadPerfHiddenGroups(){
  try {
    const saved = JSON.parse(localStorage.getItem(PERF_HIDE_STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter(g => PERF_HIDE_GROUPS.includes(g)) : [];
  } catch (e) {
    return [];
  }
}

function savePerfHiddenGroups(groups){
  try {
    localStorage.setItem(PERF_HIDE_STORAGE_KEY, JSON.stringify(groups));
  } catch (e) {
    // localStorage를 쓸 수 없는 환경이면 조용히 무시합니다.
  }
}

function initPerformanceTab(){
  const table = document.getElementById("perf-table");
  if (!table) return;

  const hidden = new Set(loadPerfHiddenGroups());

  const applyState = () => {
    PERF_HIDE_GROUPS.forEach(group => {
      table.classList.toggle(`hide-${group}`, hidden.has(group));
    });
    document.querySelectorAll(".perf-toggle-btn").forEach(btn => {
      const group = btn.dataset.hideGroup;
      const isHidden = hidden.has(group);
      btn.classList.toggle("active", isHidden);
      btn.textContent = (isHidden ? "숨김: " : "") + btn.dataset.label;
    });
  };

  document.querySelectorAll(".perf-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const group = btn.dataset.hideGroup;
      if (hidden.has(group)) hidden.delete(group); else hidden.add(group);
      savePerfHiddenGroups([...hidden]);
      applyState();
    });
  });

  applyState();
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
  unsubscribeWeeklyListeners();
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
/* 항목(l2) 하나당 하나의 layer3 문서를 두고, 그 안에 금주(thisWeek)/차주(nextWeek)/
   담당자(assignee) 세 필드를 각각 따로 upsert 합니다(문서 id = l2Id).
   merge:true를 써서 한 필드만 저장해도 다른 필드가 지워지지 않도록 합니다. */
async function saveL3Field(l2Id, field, value){
  await setDoc(doc(db, "layer3", l2Id), {
    team: state.team, week: currentWeekKey(), l2Id,
    [field]: value,
    updatedAt: serverTimestamp()
  }, { merge: true });
}
async function clearL3Field(l2Id, field){
  await saveL3Field(l2Id, field, "");
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
  // Firestore는 where()만 걸고 orderBy가 없으면 문서 순서를 보장하지 않습니다(문서 ID
  // 순서 등으로 뒤섞여 나올 수 있음). 화면에 보이던 것과 같은 순서로 가져오기가
  // 되도록, 반환하기 전에 항상 생성 시각 기준으로 정렬해 둡니다.
  return {
    l1: sortByCreatedAt(s1.docs.map(d => ({ id: d.id, ...d.data() }))),
    l2: sortByCreatedAt(s2.docs.map(d => ({ id: d.id, ...d.data() }))),
    l3: sortByCreatedAt(s3.docs.map(d => ({ id: d.id, ...d.data() }))),
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

  const carryCount = prevData.l3.filter(x => getL3Fields(x).nextWeek).length;
  let msg = `지난 주(${prevWeek}) 내용을 이번 주로 복사합니다.\n분류 ${prevData.l1.length}개 · 항목 ${prevData.l2.length}개`;
  if (carryCount > 0) {
    msg += `\n지난 주 "차주" 칸에 적은 ${carryCount}건은 이번 주 "금주" 칸으로 옮겨집니다(한 번만 반영되며, 이후 서로 영향을 주지 않습니다).`;
  }
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
  // 지난 주 "차주" 값을 이번 주 "금주" 값으로 1회성 이관합니다(일방향 — 이후 이번 주
  // "금주"를 고쳐도 지난 주 "차주"에는 영향이 없고, 지난 주 "차주"를 나중에 또 고쳐도
  // 이미 복사된 이번 주 값이 저절로 다시 바뀌지 않습니다). "금주"는 새 주 것이라 이어받지
  // 않고, 담당자만 그대로 유지합니다.
  for (const l3 of prevData.l3) {
    const newL2Id = l2IdMap[l3.l2Id];
    if (!newL2Id) continue;
    const oldFields = getL3Fields(l3);
    const carriedThisWeek = oldFields.nextWeek;
    const carriedAssignee = oldFields.assignee;
    if (!carriedThisWeek && !carriedAssignee) continue;
    await setDoc(doc(db, "layer3", newL2Id), {
      team: state.team, week: curWeek, l2Id: newL2Id,
      thisWeek: carriedThisWeek,
      nextWeek: "",
      assignee: carriedAssignee,
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

    // week 필드가 없는 문서(이전 버전에서 만들어진 옛 데이터 등)가 섞여 있어도
    // 내보내기가 죽지 않도록, 없으면 "미지정" 시트로 묶습니다.
    const weekOf = (x) => (x && typeof x.week === "string" && x.week) ? x.week : "미지정";

    const weeks = Array.from(new Set(allL1.map(weekOf))).sort();
    if (weeks.length === 0) {
      alert("내보낼 데이터가 없습니다.");
      return;
    }

    const wb = XLSX.utils.book_new();
    const usedSheetNames = new Set();

    weeks.forEach(week => {
      const weekL1 = sortByCreatedAt(allL1.filter(x => weekOf(x) === week));
      const rows = [["분류", "항목", "금주", "차주", "담당자"]];
      const merges = [];

      weekL1.forEach(l1 => {
        const children = sortByCreatedAt(allL2.filter(x => x.l1Id === l1.id && weekOf(x) === week));
        const startRow = rows.length; // 0-indexed, header가 0행
        if (children.length === 0) {
          rows.push([l1.name || "", "", "", "", ""]);
        } else {
          children.forEach((l2, idx) => {
            const entry = allL3.find(x => x.l2Id === l2.id);
            const f = getL3Fields(entry);
            rows.push([idx === 0 ? (l1.name || "") : "", l2.name || "", f.thisWeek, f.nextWeek, f.assignee]);
          });
          if (children.length > 1) {
            merges.push({ s: { r: startRow, c: 0 }, e: { r: startRow + children.length - 1, c: 0 } });
          }
        }
      });

      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!merges"] = merges;
      ws["!cols"] = [{ wch: 20 }, { wch: 20 }, { wch: 40 }, { wch: 40 }, { wch: 14 }];

      let sheetName = String(week).replace(/[\[\]\*\/\\\?:]/g, "-").slice(0, 31) || "Sheet";
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
   지시사항 탭
   -----------------------------------------------------------------------
   담당팀/주차와 무관하게 하나의 표에서 전체 지시사항을 관리합니다(팀은
   필터링 가능한 값일 뿐, 주간보고처럼 팀별 탭으로 나뉘지 않습니다).
   ===================================================================== */
const DIRECTIVE_STATUS_LABEL = { pending: "진행 전", in_progress: "진행 중", done: "완료" };
const DIRECTIVE_STATUS_DOT = { pending: "🔴", in_progress: "🟡", done: "🟢" }; // 진행전=빨강, 진행중=노랑, 완료=초록
const DIRECTIVE_STATUS_ORDER = { in_progress: 0, pending: 1, done: 2 }; // 기본 정렬 시 "진행 중" 우선
const DIRECTIVE_TEAM_LABEL = { planning: "영업기획팀", management: "영업관리팀" };

function subscribeDirectives(){
  const q = query(collection(db, "directives"));
  unsubDirectives = onSnapshot(q, snap => {
    state.directives = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.directivesFetchError = null;
    renderDirectiveTable();
  }, (err) => {
    console.error("directives 구독 오류", err);
    state.directivesFetchError = "Firestore 연결에 실패했습니다. firebase-config.js 값과 firestore.rules 배포 상태를 확인하세요.";
    renderDirectiveTable();
  });
}

async function addDirective(data){
  await addDoc(collection(db, "directives"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}
async function updateDirective(id, data){
  await updateDoc(doc(db, "directives", id), { ...data, updatedAt: serverTimestamp() });
}
async function deleteDirective(id){
  await deleteDoc(doc(db, "directives", id));
}

/* ---- 필터 + 정렬 ---- */
function getFilteredSortedDirectives(){
  const { team, status, q } = state.directivesFilter;
  const needle = q.trim().toLowerCase();

  let arr = state.directives.filter(d => {
    if (team !== "all" && d.team !== team) return false;
    if (status !== "all" && d.status !== status) return false;
    if (needle) {
      const hay = `${d.content || ""} ${d.assignee || ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const { field, dir } = state.directivesSort;

  if (!field) {
    // 기본 정렬: "진행 중" 항목을 맨 위로, 그 안에서는 지시 날짜 내림차순(최근 지시 먼저)
    arr = arr.slice().sort((a, b) => {
      const sp = (DIRECTIVE_STATUS_ORDER[a.status] ?? 9) - (DIRECTIVE_STATUS_ORDER[b.status] ?? 9);
      if (sp !== 0) return sp;
      return (b.instructionDate || "").localeCompare(a.instructionDate || "");
    });
    return arr;
  }

  const cmp = (a, b) => {
    if (field === "status") {
      // 라벨(이모지 포함) 텍스트 비교 대신 진행 흐름 순서(진행 중 → 진행 전 → 완료)로 비교합니다.
      return (DIRECTIVE_STATUS_ORDER[a.status] ?? 9) - (DIRECTIVE_STATUS_ORDER[b.status] ?? 9);
    }
    if (field === "team") {
      const av = DIRECTIVE_TEAM_LABEL[a.team] || "";
      const bv = DIRECTIVE_TEAM_LABEL[b.team] || "";
      return av.localeCompare(bv, "ko");
    }
    if (field === "instructionDate" || field === "dueDate") {
      return (a[field] || "").localeCompare(b[field] || "");
    }
    return String(a[field] || "").localeCompare(String(b[field] || ""), "ko");
  };

  arr = arr.slice().sort(cmp);
  if (dir === "desc") arr.reverse();
  return arr;
}

/* ---- 초기화(탭 상호작용 연결) ---- */
function initDirectivesTab(){
  document.getElementById("add-directive-btn").addEventListener("click", () => openDirectiveModal("add"));

  document.getElementById("dir-filter-team").addEventListener("change", (e) => {
    state.directivesFilter.team = e.target.value;
    renderDirectiveTable();
  });
  document.getElementById("dir-filter-status").addEventListener("change", (e) => {
    state.directivesFilter.status = e.target.value;
    renderDirectiveTable();
  });
  document.getElementById("dir-filter-q").addEventListener("input", (e) => {
    state.directivesFilter.q = e.target.value;
    renderDirectiveTable();
  });
  document.getElementById("dir-filter-reset").addEventListener("click", () => {
    state.directivesFilter = { team: "all", status: "all", q: "" };
    document.getElementById("dir-filter-team").value = "all";
    document.getElementById("dir-filter-status").value = "all";
    document.getElementById("dir-filter-q").value = "";
    renderDirectiveTable();
  });

  document.querySelectorAll(".directive-table th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const field = th.dataset.sort;
      if (state.directivesSort.field === field) {
        state.directivesSort.dir = state.directivesSort.dir === "asc" ? "desc" : "asc";
      } else {
        state.directivesSort.field = field;
        state.directivesSort.dir = "asc";
      }
      renderDirectiveTable();
    });
  });

  document.getElementById("directive-modal-cancel").addEventListener("click", closeDirectiveModal);
  document.getElementById("directive-modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "directive-modal-overlay") closeDirectiveModal();
  });
  document.getElementById("directive-form").addEventListener("submit", onDirectiveFormSubmit);
}

/* ---- 렌더링 ---- */
const directiveStatusBanner = document.getElementById("directive-status-banner");
const directiveTableWrap = document.getElementById("directive-table-wrap");
const directiveTbody = document.getElementById("directive-tbody");

function renderDirectiveTable(){
  updateSortArrows();

  if (state.directivesFetchError) {
    directiveStatusBanner.textContent = state.directivesFetchError;
    directiveStatusBanner.hidden = false;
    directiveTableWrap.hidden = true;
    return;
  }
  directiveStatusBanner.hidden = true;
  directiveTableWrap.hidden = false;

  const rows = getFilteredSortedDirectives();
  directiveTbody.innerHTML = "";

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    const hasAny = state.directives.length > 0;
    const div = document.createElement("div");
    div.className = "empty-hint";
    div.textContent = hasAny
      ? "필터 조건에 맞는 지시사항이 없습니다."
      : "등록된 지시사항이 없습니다. 위 '+ 지시사항 추가'로 새로 만드세요.";
    td.appendChild(div);
    tr.appendChild(td);
    directiveTbody.appendChild(tr);
    return;
  }

  const todayStr = currentDateStr();

  rows.forEach(dv => {
    const tr = document.createElement("tr");

    const tdInst = document.createElement("td");
    tdInst.textContent = dv.instructionDate || "-";
    tr.appendChild(tdInst);

    const tdDue = document.createElement("td");
    tdDue.className = "directive-due";
    tdDue.textContent = dv.dueDate || "-";
    if (dv.dueDate && dv.status !== "done" && dv.dueDate < todayStr) tdDue.classList.add("overdue");
    tr.appendChild(tdDue);

    const tdContent = document.createElement("td");
    const contentDiv = document.createElement("div");
    contentDiv.className = "directive-content-text";
    contentDiv.textContent = dv.content || "";
    tdContent.appendChild(contentDiv);
    tr.appendChild(tdContent);

    const tdTeam = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "directive-team-badge" + (dv.team === "management" ? " management" : "");
    badge.textContent = DIRECTIVE_TEAM_LABEL[dv.team] || dv.team || "-";
    tdTeam.appendChild(badge);
    tr.appendChild(tdTeam);

    const tdAssignee = document.createElement("td");
    tdAssignee.textContent = dv.assignee || "-";
    tr.appendChild(tdAssignee);

    const tdStatus = document.createElement("td");
    const statusSelect = document.createElement("select");
    statusSelect.className = "status-select status-" + (dv.status || "pending");
    ["pending", "in_progress", "done"].forEach(s => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = `${DIRECTIVE_STATUS_DOT[s]} ${DIRECTIVE_STATUS_LABEL[s]}`;
      if (dv.status === s) opt.selected = true;
      statusSelect.appendChild(opt);
    });
    statusSelect.addEventListener("change", async (e) => {
      const newStatus = e.target.value;
      statusSelect.disabled = true;
      try {
        await updateDirective(dv.id, { status: newStatus });
      } finally {
        statusSelect.disabled = false;
      }
    });
    tdStatus.appendChild(statusSelect);
    tr.appendChild(tdStatus);

    const tdActions = document.createElement("td");
    tdActions.className = "directive-actions-cell";
    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = "편집";
    editBtn.addEventListener("click", () => openDirectiveModal("edit", dv));
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn danger";
    delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => {
      if (confirm("이 지시사항을 삭제할까요?")) deleteDirective(dv.id);
    });
    tdActions.appendChild(editBtn);
    tdActions.appendChild(delBtn);
    tr.appendChild(tdActions);

    directiveTbody.appendChild(tr);
  });
}

function updateSortArrows(){
  document.querySelectorAll(".directive-table th.sortable").forEach(th => {
    const existing = th.querySelector(".sort-arrow");
    if (existing) existing.remove();
    if (state.directivesSort.field === th.dataset.sort) {
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      arrow.textContent = state.directivesSort.dir === "asc" ? "▲" : "▼";
      th.appendChild(arrow);
    }
  });
}

function currentDateStr(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

/* ---- 추가/편집 모달 ---- */
function openDirectiveModal(mode, dv){
  state.directiveModalMode = mode;
  state.directiveEditingId = mode === "edit" && dv ? dv.id : null;

  document.getElementById("directive-modal-title").textContent = mode === "edit" ? "지시사항 편집" : "지시사항 추가";
  document.getElementById("directive-form-error").textContent = "";

  const instDateEl = document.getElementById("dir-input-instruction-date");
  const dueDateEl = document.getElementById("dir-input-due-date");
  const contentEl = document.getElementById("dir-input-content");
  const teamEl = document.getElementById("dir-input-team");
  const assigneeEl = document.getElementById("dir-input-assignee");
  const statusEl = document.getElementById("dir-input-status");

  if (mode === "edit" && dv) {
    instDateEl.value = dv.instructionDate || "";
    dueDateEl.value = dv.dueDate || "";
    contentEl.value = dv.content || "";
    teamEl.value = dv.team || "planning";
    assigneeEl.value = dv.assignee || "";
    statusEl.value = dv.status || "pending";
  } else {
    instDateEl.value = currentDateStr();
    dueDateEl.value = "";
    contentEl.value = "";
    teamEl.value = "planning";
    assigneeEl.value = "";
    statusEl.value = "pending";
  }

  document.getElementById("directive-modal-overlay").hidden = false;
  contentEl.focus();
}

function closeDirectiveModal(){
  document.getElementById("directive-modal-overlay").hidden = true;
  state.directiveModalMode = null;
  state.directiveEditingId = null;
}

async function onDirectiveFormSubmit(e){
  e.preventDefault();
  const errorEl = document.getElementById("directive-form-error");
  errorEl.textContent = "";

  const instructionDate = document.getElementById("dir-input-instruction-date").value;
  const dueDate = document.getElementById("dir-input-due-date").value;
  const content = document.getElementById("dir-input-content").value.trim();
  const team = document.getElementById("dir-input-team").value;
  const assignee = document.getElementById("dir-input-assignee").value.trim();
  const status = document.getElementById("dir-input-status").value;

  if (!instructionDate) { errorEl.textContent = "지시 날짜를 입력하세요."; return; }
  if (!content) { errorEl.textContent = "지시사항 내용을 입력하세요."; return; }

  const saveBtn = document.querySelector('#directive-form button[type="submit"]');
  saveBtn.disabled = true;
  try {
    const data = { instructionDate, dueDate: dueDate || "", content, team, assignee, status };
    if (state.directiveModalMode === "edit" && state.directiveEditingId) {
      await updateDirective(state.directiveEditingId, data);
    } else {
      await addDirective(data);
    }
    closeDirectiveModal();
  } catch (err) {
    console.error(err);
    errorEl.textContent = "저장 중 오류가 발생했습니다: " + err.message;
  } finally {
    saveBtn.disabled = false;
  }
}

/* =====================================================================
   식당 탭 — 팀 구분 없이 전체가 함께 보는 하나의 공유 메모장입니다.
   사진은 별도 저장소(Firebase Storage) 없이, 브라우저에서 자동으로
   작게 압축한 뒤 글 내용과 함께 Firestore 문서 안에 그대로 저장합니다
   (Storage를 쓰려면 유료 요금제 업그레이드가 필요해, 완전 무료 구성을
   유지하기 위한 선택입니다). 그래서 한 식당당 사진은 최대 4장, 압축 후
   합쳐서 약 900KB를 넘지 않도록 제한합니다(Firestore 문서 1개당 1MB 한도).
   ===================================================================== */
const REST_MAX_IMAGES = 4;
const REST_MAX_DIM = 800;          // 압축 후 긴 변 최대 길이(px)
const REST_JPEG_QUALITY = 0.6;
const REST_MAX_TOTAL_BYTES = 900 * 1024; // 식당 1건당 사진 총합 한도

function subscribeRestaurants(){
  const q = query(collection(db, "restaurants"));
  unsubRestaurants = onSnapshot(q, snap => {
    // 최신 등록순(먼저 만든 순으로 정렬한 뒤 뒤집음)으로 보여줍니다.
    state.restaurants = sortByCreatedAt(snap.docs.map(d => ({ id: d.id, ...d.data() }))).reverse();
    state.restaurantsFetchError = null;
    renderRestaurants();
  }, (err) => {
    console.error("restaurants 구독 오류", err);
    state.restaurantsFetchError = "Firestore 연결에 실패했습니다. firebase-config.js 값과 firestore.rules 배포 상태를 확인하세요.";
    renderRestaurants();
  });
}

async function addRestaurant(data){
  await addDoc(collection(db, "restaurants"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}
async function updateRestaurant(id, data){
  await updateDoc(doc(db, "restaurants", id), { ...data, updatedAt: serverTimestamp() });
}
async function deleteRestaurant(id){
  await deleteDoc(doc(db, "restaurants", id));
}

function getFilteredRestaurants(){
  const { category, location, q } = state.restaurantFilter;
  const needle = q.trim().toLowerCase();
  return state.restaurants.filter(r => {
    if (category !== "all" && r.category !== category) return false;
    if (location !== "all" && r.location !== location) return false;
    if (needle) {
      const hay = `${r.name || ""} ${r.memo || ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/* ---- 사진 압축 (Storage 없이 Firestore에 바로 저장하기 위함) ---- */
function dataUrlBytes(dataUrl){
  const idx = dataUrl.indexOf(",");
  const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
  return Math.floor(b64.length * 0.75);
}

function compressImageFile(file){
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      if (width > REST_MAX_DIM || height > REST_MAX_DIM) {
        if (width >= height) {
          height = Math.round(height * (REST_MAX_DIM / width));
          width = REST_MAX_DIM;
        } else {
          width = Math.round(width * (REST_MAX_DIM / height));
          height = REST_MAX_DIM;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", REST_JPEG_QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("이미지를 불러올 수 없습니다.")); };
    img.src = objectUrl;
  });
}

async function addPendingImagesFromFiles(fileList){
  const errorEl = document.getElementById("restaurant-form-error");
  const files = Array.from(fileList || []).filter(f => f.type && f.type.startsWith("image/"));
  if (files.length === 0) return;

  for (const file of files) {
    if (pendingRestaurantImages.length >= REST_MAX_IMAGES) {
      errorEl.textContent = `사진은 최대 ${REST_MAX_IMAGES}장까지 첨부할 수 있습니다.`;
      break;
    }
    let dataUrl;
    try {
      dataUrl = await compressImageFile(file);
    } catch (e) {
      console.error(e);
      errorEl.textContent = "이미지를 불러오지 못했습니다. 다른 파일로 시도해보세요.";
      continue;
    }
    const currentTotal = pendingRestaurantImages.reduce((sum, d) => sum + dataUrlBytes(d), 0);
    if (currentTotal + dataUrlBytes(dataUrl) > REST_MAX_TOTAL_BYTES) {
      errorEl.textContent = "사진 용량이 너무 큽니다. 사진 수를 줄이거나 더 작은 이미지로 시도해보세요.";
      break;
    }
    pendingRestaurantImages.push(dataUrl);
  }
  renderImagePreviews();
}

function renderImagePreviews(){
  const list = document.getElementById("rest-image-preview-list");
  list.innerHTML = "";
  pendingRestaurantImages.forEach((dataUrl, idx) => {
    const item = document.createElement("div");
    item.className = "image-preview-item";

    const img = document.createElement("img");
    img.src = dataUrl;
    img.addEventListener("click", () => openLightbox(dataUrl));

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "×";
    removeBtn.title = "사진 삭제";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingRestaurantImages.splice(idx, 1);
      renderImagePreviews();
    });

    item.appendChild(img);
    item.appendChild(removeBtn);
    list.appendChild(item);
  });
}

function initRestaurantImageInput(){
  const dropzone = document.getElementById("rest-image-dropzone");
  const fileInput = document.getElementById("rest-image-file-input");
  const pickBtn = document.getElementById("rest-image-pick-btn");

  pickBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    addPendingImagesFromFiles(e.target.files);
    fileInput.value = "";
  });

  dropzone.addEventListener("click", (e) => {
    if (e.target === pickBtn) return;
    dropzone.focus();
  });

  dropzone.addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addPendingImagesFromFiles(files);
    }
  });

  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer && e.dataTransfer.files) addPendingImagesFromFiles(e.dataTransfer.files);
  });
}

/* ---- 사진 확대보기 ---- */
function openLightbox(src){
  document.getElementById("image-lightbox-img").src = src;
  document.getElementById("image-lightbox-overlay").hidden = false;
}
function closeLightbox(){
  document.getElementById("image-lightbox-overlay").hidden = true;
  document.getElementById("image-lightbox-img").src = "";
}

/* ---- 초기화(탭 상호작용 연결) ---- */
function initRestaurantsTab(){
  document.getElementById("add-restaurant-btn").addEventListener("click", () => openRestaurantModal("add"));

  document.getElementById("rest-filter-category").addEventListener("change", (e) => {
    state.restaurantFilter.category = e.target.value;
    renderRestaurants();
  });
  document.getElementById("rest-filter-location").addEventListener("change", (e) => {
    state.restaurantFilter.location = e.target.value;
    renderRestaurants();
  });
  document.getElementById("rest-filter-q").addEventListener("input", (e) => {
    state.restaurantFilter.q = e.target.value;
    renderRestaurants();
  });
  document.getElementById("rest-filter-reset").addEventListener("click", () => {
    state.restaurantFilter = { category: "all", location: "all", q: "" };
    document.getElementById("rest-filter-category").value = "all";
    document.getElementById("rest-filter-location").value = "all";
    document.getElementById("rest-filter-q").value = "";
    renderRestaurants();
  });

  document.getElementById("restaurant-modal-cancel").addEventListener("click", closeRestaurantModal);
  document.getElementById("restaurant-modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "restaurant-modal-overlay") closeRestaurantModal();
  });
  document.getElementById("restaurant-form").addEventListener("submit", onRestaurantFormSubmit);

  initRestaurantImageInput();

  document.getElementById("image-lightbox-overlay").addEventListener("click", closeLightbox);
}

/* ---- 렌더링 ---- */
const restaurantStatusBanner = document.getElementById("restaurant-status-banner");
const restaurantGrid = document.getElementById("restaurant-grid");

function renderRestaurants(){
  if (state.restaurantsFetchError) {
    restaurantStatusBanner.textContent = state.restaurantsFetchError;
    restaurantStatusBanner.hidden = false;
    restaurantGrid.hidden = true;
    return;
  }
  restaurantStatusBanner.hidden = true;
  restaurantGrid.hidden = false;

  const rows = getFilteredRestaurants();
  restaurantGrid.innerHTML = "";

  if (rows.length === 0) {
    const div = document.createElement("div");
    div.className = "empty-hint restaurant-empty";
    div.textContent = state.restaurants.length > 0
      ? "필터 조건에 맞는 식당이 없습니다."
      : "등록된 식당이 없습니다. 위 '+ 식당 추가'로 회사 주변 맛집을 공유해보세요.";
    restaurantGrid.appendChild(div);
    return;
  }

  rows.forEach(r => restaurantGrid.appendChild(buildRestaurantCard(r)));
}

function buildRestaurantCard(r){
  const card = document.createElement("div");
  card.className = "restaurant-card";

  const images = Array.isArray(r.images) ? r.images : [];
  if (images.length > 0) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "restaurant-card-images" + (images.length === 1 ? " single" : "");
    images.slice(0, REST_MAX_IMAGES).forEach(src => {
      const img = document.createElement("img");
      img.src = src;
      img.loading = "lazy";
      img.addEventListener("click", () => openLightbox(src));
      imgWrap.appendChild(img);
    });
    card.appendChild(imgWrap);
  }

  const body = document.createElement("div");
  body.className = "restaurant-card-body";

  const tags = document.createElement("div");
  tags.className = "restaurant-card-tags";
  const catTag = document.createElement("span");
  catTag.className = "tag tag-category";
  catTag.textContent = r.category || "기타";
  const locTag = document.createElement("span");
  locTag.className = "tag tag-location";
  locTag.textContent = r.location || "기타";
  tags.appendChild(catTag);
  tags.appendChild(locTag);
  body.appendChild(tags);

  const name = document.createElement("div");
  name.className = "restaurant-card-name";
  name.textContent = r.name || "(이름 없음)";
  body.appendChild(name);

  if (r.memo) {
    const memo = document.createElement("div");
    memo.className = "restaurant-card-memo";
    memo.textContent = r.memo;
    body.appendChild(memo);
  }

  const meta = document.createElement("div");
  meta.className = "restaurant-card-meta";
  const authorSpan = document.createElement("span");
  authorSpan.textContent = r.author ? `작성자: ${r.author}` : "";
  meta.appendChild(authorSpan);
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  meta.appendChild(spacer);
  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.textContent = "편집";
  editBtn.addEventListener("click", () => openRestaurantModal("edit", r));
  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn danger";
  delBtn.textContent = "삭제";
  delBtn.addEventListener("click", () => {
    if (confirm(`"${r.name || "이 식당"}" 기록을 삭제할까요?`)) deleteRestaurant(r.id);
  });
  meta.appendChild(editBtn);
  meta.appendChild(delBtn);
  body.appendChild(meta);

  card.appendChild(body);
  return card;
}

/* ---- 추가/편집 모달 ---- */
function openRestaurantModal(mode, r){
  state.restaurantModalMode = mode;
  state.restaurantEditingId = mode === "edit" && r ? r.id : null;
  pendingRestaurantImages = mode === "edit" && r && Array.isArray(r.images) ? [...r.images] : [];

  document.getElementById("restaurant-modal-title").textContent = mode === "edit" ? "식당 편집" : "식당 추가";
  document.getElementById("restaurant-form-error").textContent = "";

  const nameEl = document.getElementById("rest-input-name");
  const categoryEl = document.getElementById("rest-input-category");
  const locationEl = document.getElementById("rest-input-location");
  const memoEl = document.getElementById("rest-input-memo");
  const authorEl = document.getElementById("rest-input-author");

  if (mode === "edit" && r) {
    nameEl.value = r.name || "";
    categoryEl.value = r.category || "한식";
    locationEl.value = r.location || "방이";
    memoEl.value = r.memo || "";
    authorEl.value = r.author || "";
  } else {
    nameEl.value = "";
    categoryEl.value = "한식";
    locationEl.value = "방이";
    memoEl.value = "";
    authorEl.value = "";
  }

  renderImagePreviews();
  document.getElementById("restaurant-modal-overlay").hidden = false;
  nameEl.focus();
}

function closeRestaurantModal(){
  document.getElementById("restaurant-modal-overlay").hidden = true;
  state.restaurantModalMode = null;
  state.restaurantEditingId = null;
  pendingRestaurantImages = [];
}

async function onRestaurantFormSubmit(e){
  e.preventDefault();
  const errorEl = document.getElementById("restaurant-form-error");
  errorEl.textContent = "";

  const name = document.getElementById("rest-input-name").value.trim();
  const category = document.getElementById("rest-input-category").value;
  const location = document.getElementById("rest-input-location").value;
  const memo = document.getElementById("rest-input-memo").value.trim();
  const author = document.getElementById("rest-input-author").value.trim();

  if (!name) { errorEl.textContent = "식당명을 입력하세요."; return; }

  const saveBtn = document.querySelector('#restaurant-form button[type="submit"]');
  saveBtn.disabled = true;
  try {
    const data = { name, category, location, memo, author, images: [...pendingRestaurantImages] };
    if (state.restaurantModalMode === "edit" && state.restaurantEditingId) {
      await updateRestaurant(state.restaurantEditingId, data);
    } else {
      await addRestaurant(data);
    }
    closeRestaurantModal();
  } catch (err) {
    console.error(err);
    errorEl.textContent = "저장 중 오류가 발생했습니다: " + err.message;
  } finally {
    saveBtn.disabled = false;
  }
}

/* =====================================================================
   운영체크리스트 탭 — "운영 프로젝트"(글로벌비즈니스어워드, 타운홀 행사 등)를
   여러 개 만들 수 있고, 프로젝트마다 구분/번호/항목/내용/비고로 이루어진
   체크리스트를 가집니다. 완료 체크박스와 담당자는 표에서 바로 편집하고,
   구분/번호/항목/내용/비고 다섯 칸은 엑셀 업로드로 한 번에 채워 넣거나
   "+ 항목 추가"로 한 줄씩 넣을 수 있습니다.
   ===================================================================== */

/* ---- 프로젝트(checklistProjects) ---- */
function subscribeChecklistProjects(){
  const q = query(collection(db, "checklistProjects"));
  unsubChecklistProjects = onSnapshot(q, snap => {
    state.checklistProjects = sortByCreatedAt(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    // 지금 선택된 프로젝트가 삭제되었거나, 아직 아무것도 선택 안 한 상태면
    // 첫 번째 프로젝트를 자동으로 선택합니다.
    const stillExists = state.checklistProjects.some(p => p.id === state.checklistActiveProjectId);
    if (!stillExists) {
      const next = state.checklistProjects[0];
      if (next) {
        selectChecklistProject(next.id);
      } else {
        state.checklistActiveProjectId = null;
        renderChecklistProjectBar();
      }
    } else {
      renderChecklistProjectBar();
    }
  }, (err) => {
    console.error("checklistProjects 구독 오류", err);
    state.checklistProjects = [];
    renderChecklistProjectBar();
  });
}

async function addChecklistProject(name){
  const ref = await addDoc(collection(db, "checklistProjects"), { name, createdAt: serverTimestamp() });
  return ref.id;
}
async function deleteChecklistProject(id){
  // 이 프로젝트 소속 항목을 전부 먼저 지운 뒤 프로젝트 문서를 지웁니다(연쇄 삭제).
  const snap = await getDocs(query(collection(db, "checklistItems"), where("projectId", "==", id)));
  for (const d of snap.docs) await deleteDoc(doc(db, "checklistItems", d.id));
  await deleteDoc(doc(db, "checklistProjects", id));
}

function selectChecklistProject(id){
  if (state.checklistActiveProjectId === id) return;
  state.checklistActiveProjectId = id;
  state.checklistItems = [];
  state.checklistItemsFetchError = null;
  if (unsubChecklistItems) { unsubChecklistItems(); unsubChecklistItems = null; }
  renderChecklistProjectBar();
  if (id) {
    subscribeChecklistItems(id);
  } else {
    renderChecklistTable();
  }
}

/* ---- 항목(checklistItems) ---- */
function subscribeChecklistItems(projectId){
  const q = query(collection(db, "checklistItems"), where("projectId", "==", projectId));
  unsubChecklistItems = onSnapshot(q, snap => {
    state.checklistItems = sortByCreatedAt(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    state.checklistItemsFetchError = null;
    renderChecklistTable();
  }, (err) => {
    console.error("checklistItems 구독 오류", err);
    state.checklistItemsFetchError = "Firestore 연결에 실패했습니다. firebase-config.js 값과 firestore.rules 배포 상태를 확인하세요.";
    renderChecklistTable();
  });
}

async function addChecklistItem(projectId, data){
  await addDoc(collection(db, "checklistItems"), {
    projectId,
    category: data.category || "",
    no: data.no || "",
    item: data.item || "",
    content: data.content || "",
    note: data.note || "",
    done: !!data.done,
    assignee: data.assignee || "",
    createdAt: serverTimestamp(),
  });
}
async function updateChecklistItem(id, data){
  await updateDoc(doc(db, "checklistItems", id), data);
}
async function deleteChecklistItem(id){
  await deleteDoc(doc(db, "checklistItems", id));
}
async function clearChecklistItems(projectId){
  const snap = await getDocs(query(collection(db, "checklistItems"), where("projectId", "==", projectId)));
  for (const d of snap.docs) await deleteDoc(doc(db, "checklistItems", d.id));
}

/* ---- 엑셀 업로드 (구분/번호/항목/내용/비고 열을 찾아서 읽습니다) ---- */
const CHECKLIST_EXCEL_HEADERS = { category: "구분", no: "번호", item: "항목", content: "내용", note: "비고" };

function readChecklistExcelFile(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다."));
    reader.readAsArrayBuffer(file);
  });
}

/* 엑셀 원본 2차원 배열 → {category, no, item, content, note} 목록.
   - 헤더 행은 위쪽 10줄 안에서 "구분/번호/항목/내용/비고" 중 4개 이상이 보이는 줄로 찾습니다
     (열 순서가 스크린샷과 달라도 제목으로 찾으므로 상관없습니다).
   - 엑셀에서 구분/항목 칸이 병합되어 있으면 병합된 칸 중 첫 줄에만 값이 들어오고
     나머지는 빈 칸으로 읽히므로, 빈 칸은 바로 위 줄의 값을 그대로 이어받습니다. */
function mapChecklistExcelRows(rows){
  let headerRowIdx = -1;
  let colIdx = {};
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = (rows[i] || []).map(c => String(c === undefined || c === null ? "" : c).trim());
    const found = {};
    Object.entries(CHECKLIST_EXCEL_HEADERS).forEach(([key, label]) => {
      const idx = row.indexOf(label);
      if (idx >= 0) found[key] = idx;
    });
    if (Object.keys(found).length >= 4) {
      headerRowIdx = i;
      colIdx = found;
      break;
    }
  }
  if (headerRowIdx === -1) {
    throw new Error("엑셀에서 '구분/번호/항목/내용/비고' 열 제목을 찾지 못했습니다. 첫 줄(또는 상단 몇 줄 안)에 이 제목들이 그대로 있는지 확인해주세요.");
  }

  const items = [];
  let lastCategory = "", lastItem = "";
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const get = (key) => {
      const idx = colIdx[key];
      if (idx === undefined) return "";
      const v = row[idx];
      return v === undefined || v === null ? "" : String(v).trim();
    };
    let category = get("category");
    let item = get("item");
    const no = get("no");
    const content = get("content");
    const note = get("note");

    if (!category && !item && !no && !content && !note) continue; // 완전히 빈 줄은 건너뜁니다

    if (!category) category = lastCategory; else lastCategory = category;
    if (!item) item = lastItem; else lastItem = item;

    items.push({ category, no, item, content, note });
  }
  return items;
}

function initChecklistExcelUpload(){
  const btn = document.getElementById("checklist-excel-upload-btn");
  const input = document.getElementById("checklist-excel-input");

  btn.addEventListener("click", () => {
    if (!state.checklistActiveProjectId) return;
    input.click();
  });

  input.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    input.value = "";
    if (!file || !state.checklistActiveProjectId) return;

    try {
      const rows = await readChecklistExcelFile(file);
      const items = mapChecklistExcelRows(rows);
      if (items.length === 0) {
        alert("엑셀에서 가져올 내용을 찾지 못했습니다.");
        return;
      }
      const ok = confirm(
        `${items.length}개 항목을 현재 프로젝트에 추가할까요?\n\n` +
        `기존에 있던 항목(완료 체크, 담당자 포함)은 그대로 남아있고, 새 항목이 뒤에 추가됩니다.\n` +
        `(다시 처음부터 올리고 싶다면 "전체 항목 삭제"를 먼저 눌러주세요.)`
      );
      if (!ok) return;

      btn.disabled = true;
      for (const it of items) {
        await addChecklistItem(state.checklistActiveProjectId, {
          category: it.category, no: it.no, item: it.item, content: it.content, note: it.note,
          done: false, assignee: "",
        });
      }
    } catch (err) {
      console.error(err);
      alert("엑셀을 불러오는 중 오류가 발생했습니다: " + err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---- 초기화(탭 상호작용 연결) ---- */
function initChecklistTab(){
  document.getElementById("add-checklist-item-btn").addEventListener("click", () => {
    if (!state.checklistActiveProjectId) { alert("먼저 프로젝트를 선택하거나 새로 만들어주세요."); return; }
    openChecklistItemModal("add");
  });

  document.getElementById("checklist-clear-btn").addEventListener("click", async () => {
    if (!state.checklistActiveProjectId) return;
    if (!confirm("현재 프로젝트의 모든 체크리스트 항목을 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return;
    await clearChecklistItems(state.checklistActiveProjectId);
  });

  document.getElementById("checklist-item-modal-cancel").addEventListener("click", closeChecklistItemModal);
  document.getElementById("checklist-item-modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "checklist-item-modal-overlay") closeChecklistItemModal();
  });
  document.getElementById("checklist-item-form").addEventListener("submit", onChecklistItemFormSubmit);

  initChecklistExcelUpload();
}

/* ---- 렌더링: 프로젝트 칩 목록 ---- */
function renderChecklistProjectBar(){
  const bar = document.getElementById("checklist-project-bar");
  bar.innerHTML = "";

  state.checklistProjects.forEach(p => {
    const chip = document.createElement("div");
    chip.className = "checklist-project-chip" + (p.id === state.checklistActiveProjectId ? " active" : "");

    const nameSpan = document.createElement("span");
    nameSpan.className = "chip-name";
    nameSpan.textContent = p.name;
    nameSpan.addEventListener("click", () => selectChecklistProject(p.id));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "chip-del";
    delBtn.textContent = "×";
    delBtn.title = "프로젝트 삭제";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`"${p.name}" 프로젝트와 그 안의 모든 체크리스트 항목을 삭제할까요?`)) return;
      await deleteChecklistProject(p.id);
    });

    chip.appendChild(nameSpan);
    chip.appendChild(delBtn);
    bar.appendChild(chip);
  });

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "add-project-chip";
  addBtn.textContent = "+ 새 프로젝트";
  addBtn.addEventListener("click", async () => {
    const name = prompt("새 운영 프로젝트명 (예: 글로벌비즈니스어워드)");
    if (name && name.trim()) {
      const id = await addChecklistProject(name.trim());
      selectChecklistProject(id);
    }
  });
  bar.appendChild(addBtn);

  const emptyHint = document.getElementById("checklist-empty-hint");
  const body = document.getElementById("checklist-project-body");
  if (state.checklistProjects.length === 0) {
    emptyHint.hidden = false;
    body.hidden = true;
  } else {
    emptyHint.hidden = true;
    body.hidden = !state.checklistActiveProjectId;
  }
}

/* ---- 렌더링: 체크리스트 표 (구분/항목은 연속된 같은 값끼리 세로 병합) ---- */
function computeChecklistRowSpans(items){
  return items.map((it, idx) => {
    const prev = items[idx - 1];
    const catIsFirst = !prev || prev.category !== it.category;
    const itemIsFirst = !prev || prev.category !== it.category || prev.item !== it.item;
    let catSpan = 0, itemSpan = 0;
    if (catIsFirst) {
      catSpan = 1;
      for (let j = idx + 1; j < items.length && items[j].category === it.category; j++) catSpan++;
    }
    if (itemIsFirst) {
      itemSpan = 1;
      for (let j = idx + 1; j < items.length && items[j].category === it.category && items[j].item === it.item; j++) itemSpan++;
    }
    return { ...it, _catIsFirst: catIsFirst, _catSpan: catSpan, _itemIsFirst: itemIsFirst, _itemSpan: itemSpan };
  });
}

function renderChecklistTable(){
  const banner = document.getElementById("checklist-status-banner");
  const tableWrap = document.getElementById("checklist-table-wrap");
  const tbody = document.getElementById("checklist-tbody");

  if (state.checklistItemsFetchError) {
    banner.textContent = state.checklistItemsFetchError;
    banner.hidden = false;
    tableWrap.hidden = true;
    return;
  }
  banner.hidden = true;
  tableWrap.hidden = false;
  tbody.innerHTML = "";

  if (state.checklistItems.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.appendChild(emptyHint("등록된 항목이 없습니다. 위 '+ 항목 추가'로 한 줄씩 넣거나, '엑셀로 항목 추가'로 한 번에 불러오세요."));
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const grouped = computeChecklistRowSpans(state.checklistItems);

  grouped.forEach(it => {
    const tr = document.createElement("tr");
    if (it.done) tr.classList.add("cl-done-row");

    if (it._catIsFirst) {
      const td = document.createElement("td");
      td.className = "cl-category-cell";
      if (it._catSpan > 1) td.rowSpan = it._catSpan;
      td.textContent = it.category || "-";
      tr.appendChild(td);
    }

    const tdNo = document.createElement("td");
    tdNo.className = "cl-no-cell";
    tdNo.textContent = it.no || "";
    tr.appendChild(tdNo);

    if (it._itemIsFirst) {
      const td = document.createElement("td");
      td.className = "cl-item-cell";
      if (it._itemSpan > 1) td.rowSpan = it._itemSpan;
      td.textContent = it.item || "-";
      tr.appendChild(td);
    }

    const tdContent = document.createElement("td");
    tdContent.className = "cl-content-cell";
    tdContent.textContent = it.content || "";
    tr.appendChild(tdContent);

    const tdNote = document.createElement("td");
    tdNote.className = "cl-note-cell";
    tdNote.textContent = it.note || "";
    tr.appendChild(tdNote);

    const tdDone = document.createElement("td");
    tdDone.className = "cl-done-cell";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!it.done;
    checkbox.addEventListener("change", () => updateChecklistItem(it.id, { done: checkbox.checked }));
    tdDone.appendChild(checkbox);
    tr.appendChild(tdDone);

    const tdAssignee = document.createElement("td");
    tdAssignee.className = "cl-assignee-cell";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "assignee-input";
    input.placeholder = "담당자";
    input.value = it.assignee || "";
    const commit = () => {
      const val = input.value.trim();
      if (val !== (it.assignee || "")) updateChecklistItem(it.id, { assignee: val });
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    tdAssignee.appendChild(input);
    tr.appendChild(tdAssignee);

    const tdActions = document.createElement("td");
    tdActions.className = "cl-actions-cell";
    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = "편집";
    editBtn.addEventListener("click", () => openChecklistItemModal("edit", it));
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn danger";
    delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => {
      if (confirm("이 항목을 삭제할까요?")) deleteChecklistItem(it.id);
    });
    tdActions.appendChild(editBtn);
    tdActions.appendChild(delBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

/* ---- 추가/편집 모달 (구분/번호/항목/내용/비고/담당자 — 완료 체크는 표에서 바로 토글) ---- */
function openChecklistItemModal(mode, it){
  state.checklistItemModalMode = mode;
  state.checklistItemEditingId = mode === "edit" && it ? it.id : null;

  document.getElementById("checklist-item-modal-title").textContent = mode === "edit" ? "항목 편집" : "항목 추가";
  document.getElementById("checklist-item-form-error").textContent = "";

  const categoryEl = document.getElementById("ci-input-category");
  const noEl = document.getElementById("ci-input-no");
  const itemEl = document.getElementById("ci-input-item");
  const contentEl = document.getElementById("ci-input-content");
  const noteEl = document.getElementById("ci-input-note");
  const assigneeEl = document.getElementById("ci-input-assignee");

  if (mode === "edit" && it) {
    categoryEl.value = it.category || "";
    noEl.value = it.no || "";
    itemEl.value = it.item || "";
    contentEl.value = it.content || "";
    noteEl.value = it.note || "";
    assigneeEl.value = it.assignee || "";
  } else {
    categoryEl.value = "";
    noEl.value = "";
    itemEl.value = "";
    contentEl.value = "";
    noteEl.value = "";
    assigneeEl.value = "";
  }

  document.getElementById("checklist-item-modal-overlay").hidden = false;
  categoryEl.focus();
}
function closeChecklistItemModal(){
  document.getElementById("checklist-item-modal-overlay").hidden = true;
  state.checklistItemModalMode = null;
  state.checklistItemEditingId = null;
}

async function onChecklistItemFormSubmit(e){
  e.preventDefault();
  const errorEl = document.getElementById("checklist-item-form-error");
  errorEl.textContent = "";

  const category = document.getElementById("ci-input-category").value.trim();
  const no = document.getElementById("ci-input-no").value.trim();
  const item = document.getElementById("ci-input-item").value.trim();
  const content = document.getElementById("ci-input-content").value.trim();
  const note = document.getElementById("ci-input-note").value.trim();
  const assignee = document.getElementById("ci-input-assignee").value.trim();

  if (!category) { errorEl.textContent = "구분을 입력하세요."; return; }
  if (!item) { errorEl.textContent = "항목을 입력하세요."; return; }
  if (!content) { errorEl.textContent = "내용을 입력하세요."; return; }
  if (!state.checklistActiveProjectId) { errorEl.textContent = "프로젝트를 먼저 선택하세요."; return; }

  const saveBtn = document.querySelector('#checklist-item-form button[type="submit"]');
  saveBtn.disabled = true;
  try {
    if (state.checklistItemModalMode === "edit" && state.checklistItemEditingId) {
      await updateChecklistItem(state.checklistItemEditingId, { category, no, item, content, note, assignee });
    } else {
      await addChecklistItem(state.checklistActiveProjectId, { category, no, item, content, note, assignee, done: false });
    }
    closeChecklistItemModal();
  } catch (err) {
    console.error(err);
    errorEl.textContent = "저장 중 오류가 발생했습니다: " + err.message;
  } finally {
    saveBtn.disabled = false;
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
    td.colSpan = 5;
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

      const l2Td = document.createElement("td");
      l2Td.className = "l2-cell empty-l2-cell";
      const hint = document.createElement("span");
      hint.className = "muted-text";
      hint.textContent = "항목이 없습니다.";
      const addBtn = document.createElement("button");
      addBtn.className = "inline-add-btn";
      addBtn.textContent = "+ 항목 추가";
      addBtn.addEventListener("click", () => promptAddL2(l1.id));
      l2Td.appendChild(hint);
      l2Td.appendChild(addBtn);
      tr.appendChild(l2Td);

      /* 항목이 아직 없어도 금주/차주/담당자 칸을 실제 항목이 있는 행과 똑같이
         5칸으로 나눠서 그려줍니다 — 그래야 표 전체의 세로 구분선과 행 높이가
         다른 분류(항목이 있는)들과 어긋나지 않습니다. */
      tr.appendChild(buildEmptyFieldCell("l3-cell thisweek-cell"));
      tr.appendChild(buildEmptyFieldCell("l3-cell nextweek-cell"));
      tr.appendChild(buildEmptyFieldCell("assignee-cell"));

      tbody.appendChild(tr);
      return;
    }

    children.forEach((l2, idx) => {
      const tr = document.createElement("tr");
      if (idx === 0) tr.appendChild(buildL1Cell(l1, children.length));
      tr.appendChild(buildL2Cell(l2));
      tr.appendChild(buildFieldCell(l2, "thisWeek", "l3-cell thisweek-cell"));
      tr.appendChild(buildFieldCell(l2, "nextWeek", "l3-cell nextweek-cell"));
      tr.appendChild(buildAssigneeCell(l2));
      tbody.appendChild(tr);
    });
  });
}

/* 항목이 없는 분류의 금주/차주/담당자 칸을 실제 항목이 있을 때와 같은 모양(점선 박스)으로
   채워주는 자리표시자입니다. 아직 항목 자체가 없어 저장할 대상이 없으므로 클릭해도
   아무 동작을 하지 않는 순수 표시용입니다. */
function buildEmptyFieldCell(className){
  const td = document.createElement("td");
  td.className = className;
  const placeholder = document.createElement("div");
  placeholder.className = "detail-placeholder placeholder-disabled";
  placeholder.textContent = "—";
  td.appendChild(placeholder);
  return td;
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

/* field: "thisWeek"(금주) | "nextWeek"(차주). 두 열 모두 같은 클릭-편집 UI를 공유합니다. */
function buildFieldCell(l2, field, className){
  const td = document.createElement("td");
  td.className = className;

  const entry = state.l3.find(x => x.l2Id === l2.id);
  const value = getL3Fields(entry)[field];
  const editKey = `${l2.id}|${field}`;

  if (state.editingKey === editKey) {
    renderFieldEditMode(td, l2, field, value);
  } else {
    renderFieldViewMode(td, l2, field, value, entry);
  }
  return td;
}

function renderFieldViewMode(td, l2, field, value, entry){
  const editKey = `${l2.id}|${field}`;
  const label = field === "thisWeek" ? "금주" : "차주";

  if (value) {
    const text = document.createElement("div");
    text.className = "detail-text";
    text.textContent = value;
    text.addEventListener("click", () => { state.editingKey = editKey; renderTable(); });
    td.appendChild(text);

    const meta = document.createElement("div");
    meta.className = "detail-meta";
    const when = entry && entry.updatedAt && entry.updatedAt.toDate ? entry.updatedAt.toDate() : null;
    const whenStr = when ? `${when.getMonth()+1}/${when.getDate()} ${String(when.getHours()).padStart(2,"0")}:${String(when.getMinutes()).padStart(2,"0")}` : "";
    meta.innerHTML = `
      <span>${whenStr}</span>
      <span class="spacer"></span>
      <button class="icon-btn" data-act="edit">편집</button>
      <button class="icon-btn danger" data-act="del">삭제</button>
    `;
    meta.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
      e.stopPropagation();
      state.editingKey = editKey;
      renderTable();
    });
    meta.querySelector('[data-act="del"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm(`${label} 내용을 삭제할까요?`)) await clearL3Field(l2.id, field);
    });
    td.appendChild(meta);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "detail-placeholder";
    placeholder.textContent = "클릭해서 작성";
    placeholder.addEventListener("click", () => { state.editingKey = editKey; renderTable(); });
    td.appendChild(placeholder);
  }
}

function renderFieldEditMode(td, l2, field, value){
  const placeholderText = field === "thisWeek" ? "금주 진행 내용을 입력하세요..." : "차주(다음 주) 계획을 입력하세요...";
  const form = document.createElement("div");
  form.className = "inline-form l3-edit-form";
  form.innerHTML = `
    <textarea placeholder="${placeholderText}"></textarea>
    <div class="row">
      <button class="btn-sm save">저장</button>
      <button class="btn-sm cancel">취소</button>
    </div>
  `;
  const textarea = form.querySelector("textarea");
  textarea.value = value || "";
  td.appendChild(form);
  textarea.focus();

  form.querySelector(".save").addEventListener("click", async () => {
    const content = textarea.value.trim();
    await saveL3Field(l2.id, field, content);
    state.editingKey = null;
    renderTable();
  });
  form.querySelector(".cancel").addEventListener("click", () => {
    state.editingKey = null;
    renderTable();
  });
}

/* 담당자 열 — 별도 편집 모드 없이 표 안에 바로 입력창이 보이고, 포커스를 벗어나거나
   Enter를 누르면 저장됩니다(스프레드시트의 셀 입력과 비슷한 느낌). */
function buildAssigneeCell(l2){
  const td = document.createElement("td");
  td.className = "assignee-cell";

  const entry = state.l3.find(x => x.l2Id === l2.id);
  const assignee = getL3Fields(entry).assignee;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "assignee-input";
  input.placeholder = "담당자";
  input.value = assignee;

  let saving = false;
  const commit = async () => {
    const val = input.value.trim();
    if (val === assignee || saving) return;
    saving = true;
    try {
      await saveL3Field(l2.id, "assignee", val);
    } finally {
      saving = false;
    }
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
  });

  td.appendChild(input);
  return td;
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
