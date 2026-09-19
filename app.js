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
  activeMainTab: "weekly",     // "weekly" | "directives"
  directives: [],              // [{id, instructionDate, dueDate, content, team, assignee, status, createdAt}]
  directivesFetchError: null,
  directivesFilter: { team: "all", status: "all", q: "" },
  directivesSort: { field: null, dir: "asc" }, // field=null → 기본(진행중 우선 + 지시날짜 내림차순) 정렬
  directiveModalMode: null,    // "add" | "edit" | null
  directiveEditingId: null,
};

let unsubL1 = null, unsubL2 = null, unsubL3 = null;
let unsubDirectives = null;

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
}

/* =====================================================================
   상단 메인 탭 전환 (주간보고 / 지시사항 / 성과관리(비활성))
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
    });
  });
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
      const td = document.createElement("td");
      td.colSpan = 4;
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
      tr.appendChild(buildFieldCell(l2, "thisWeek", "l3-cell thisweek-cell"));
      tr.appendChild(buildFieldCell(l2, "nextWeek", "l3-cell nextweek-cell"));
      tr.appendChild(buildAssigneeCell(l2));
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
