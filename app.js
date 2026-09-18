import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
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

/* =====================================================================
   상태 (State)
   ===================================================================== */
const state = {
  team: "planning",           // "planning" | "management"
  weekOffset: 0,               // 0 = 이번 주
  l1: [],                      // [{id, team, name, createdAt}]
  l2: [],                      // [{id, team, l1Id, name, createdAt}]
  l3: [],                      // [{id, team, l2Id, week, content, author, createdAt}]
  openL1: new Set(),
  openL2: new Set(),
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
      state.openL1.clear();
      state.openL2.clear();
      subscribeTeamData();
    });
  });

  document.getElementById("week-prev").addEventListener("click", () => { state.weekOffset--; renderWeekBar(); renderTree(); });
  document.getElementById("week-next").addEventListener("click", () => { state.weekOffset++; renderWeekBar(); renderTree(); });
  document.getElementById("week-today").addEventListener("click", () => { state.weekOffset = 0; renderWeekBar(); renderTree(); });

  document.getElementById("add-l1-btn").addEventListener("click", () => promptAddL1());

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
  state.fetchError = null;
  renderTree();

  const team = state.team;
  const onErr = (label) => (err) => {
    console.error(label + " 구독 오류", err);
    state.fetchError = "Firestore 연결에 실패했습니다. firebase-config.js 값과 firestore.rules 배포 상태를 확인하세요.";
    const statusEl = document.getElementById("sync-status");
    if (statusEl) statusEl.textContent = "⚠ 연결 오류";
    renderTree();
  };

  const q1 = query(collection(db, "layer1"), where("team", "==", team));
  unsubL1 = onSnapshot(q1, snap => {
    state.l1 = sortByCreatedAt(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderTree();
  }, onErr("layer1"));

  const q2 = query(collection(db, "layer2"), where("team", "==", team));
  unsubL2 = onSnapshot(q2, snap => {
    state.l2 = sortByCreatedAt(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderTree();
  }, onErr("layer2"));

  const q3 = query(collection(db, "layer3"), where("team", "==", team));
  unsubL3 = onSnapshot(q3, snap => {
    state.l3 = sortByCreatedAt(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderTree();
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
  const children = state.l3.filter(x => x.l2Id === id);
  for (const c of children) await deleteDoc(doc(db, "layer3", c.id));
  await deleteDoc(doc(db, "layer2", id));
}
async function addL3(l2Id, content, author){
  await addDoc(collection(db, "layer3"), {
    team: state.team, l2Id, week: currentWeekKey(),
    content, author: author || "", createdAt: serverTimestamp()
  });
}
async function updateL3(id, content){ await updateDoc(doc(db, "layer3", id), { content }); }
async function deleteL3(id){ await deleteDoc(doc(db, "layer3", id)); }

/* =====================================================================
   렌더링
   ===================================================================== */
const l1ListEl = document.getElementById("l1-list");

function renderTree(){
  l1ListEl.innerHTML = "";

  if (state.fetchError) {
    const div = document.createElement("div");
    div.className = "empty-hint";
    div.textContent = state.fetchError;
    l1ListEl.appendChild(div);
    return;
  }

  if (state.l1.length === 0) {
    const div = document.createElement("div");
    div.className = "empty-hint";
    div.textContent = "등록된 프로젝트가 없습니다. 위 '+ 프로젝트 추가' 버튼으로 시작하세요.";
    l1ListEl.appendChild(div);
    return;
  }

  const weekKey = currentWeekKey();

  state.l1.forEach(l1 => {
    const l2Children = state.l2.filter(x => x.l1Id === l1.id);
    const isOpen = state.openL1.has(l1.id);

    const card = document.createElement("div");
    card.className = "l1-card";

    const head = document.createElement("div");
    head.className = "l1-head" + (isOpen ? " open" : "");
    head.innerHTML = `
      <span class="chevron">▶</span>
      <span class="l1-name"></span>
      <span class="l1-count">${l2Children.length}개 카테고리</span>
      <button class="icon-btn" data-act="edit">편집</button>
      <button class="icon-btn danger" data-act="del">삭제</button>
    `;
    head.querySelector(".l1-name").textContent = l1.name;
    head.addEventListener("click", (e) => {
      if (e.target.dataset.act) return;
      if (state.openL1.has(l1.id)) state.openL1.delete(l1.id); else state.openL1.add(l1.id);
      renderTree();
    });
    head.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
      e.stopPropagation();
      const next = prompt("프로젝트명 수정", l1.name);
      if (next && next.trim()) renameL1(l1.id, next.trim());
    });
    head.querySelector('[data-act="del"]').addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`"${l1.name}" 프로젝트와 하위 카테고리/내용을 모두 삭제할까요?`)) deleteL1(l1.id);
    });
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "l1-body" + (isOpen ? " open" : "");

    const addL2Btn = document.createElement("button");
    addL2Btn.className = "add-l2-btn";
    addL2Btn.textContent = "+ 카테고리 추가";
    addL2Btn.addEventListener("click", () => promptAddL2(l1.id));
    body.appendChild(addL2Btn);

    if (l2Children.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.style.padding = "14px";
      hint.textContent = "카테고리가 없습니다.";
      body.appendChild(hint);
    }

    l2Children.forEach(l2 => {
      body.appendChild(renderL2Block(l2, weekKey));
    });

    card.appendChild(body);
    l1ListEl.appendChild(card);
  });
}

function renderL2Block(l2, weekKey){
  const entries = state.l3.filter(x => x.l2Id === l2.id && x.week === weekKey);
  const isOpen = state.openL2.has(l2.id);

  const block = document.createElement("div");
  block.className = "l2-block";

  const head = document.createElement("div");
  head.className = "l2-head" + (isOpen ? " open" : "");
  head.innerHTML = `
    <span class="chevron">▶</span>
    <span class="l2-name"></span>
    <span class="l2-count">${entries.length}건</span>
    <button class="icon-btn" data-act="edit">편집</button>
    <button class="icon-btn danger" data-act="del">삭제</button>
  `;
  head.querySelector(".l2-name").textContent = l2.name;
  head.addEventListener("click", (e) => {
    if (e.target.dataset.act) return;
    if (state.openL2.has(l2.id)) state.openL2.delete(l2.id); else state.openL2.add(l2.id);
    renderTree();
  });
  head.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
    e.stopPropagation();
    const next = prompt("카테고리명 수정", l2.name);
    if (next && next.trim()) renameL2(l2.id, next.trim());
  });
  head.querySelector('[data-act="del"]').addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm(`"${l2.name}" 카테고리와 모든 주차의 상세내용을 삭제할까요?`)) deleteL2(l2.id);
  });
  block.appendChild(head);

  const body = document.createElement("div");
  body.className = "l2-body" + (isOpen ? " open" : "");

  if (entries.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.style.padding = "12px";
    hint.style.marginBottom = "8px";
    hint.textContent = "이번 주 작성된 상세내용이 없습니다.";
    body.appendChild(hint);
  }

  entries.forEach(entry => {
    body.appendChild(renderEntryCard(entry));
  });

  const addBtn = document.createElement("button");
  addBtn.className = "add-entry-btn";
  addBtn.textContent = "+ 상세내용 추가";
  addBtn.addEventListener("click", () => showAddEntryForm(body, addBtn, l2.id));
  body.appendChild(addBtn);

  block.appendChild(body);
  return block;
}

function renderEntryCard(entry){
  const card = document.createElement("div");
  card.className = "entry-card";

  const text = document.createElement("div");
  text.className = "entry-text";
  text.textContent = entry.content;
  card.appendChild(text);

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  const when = entry.createdAt && entry.createdAt.toDate ? entry.createdAt.toDate() : null;
  const whenStr = when ? `${when.getMonth()+1}/${when.getDate()} ${String(when.getHours()).padStart(2,"0")}:${String(when.getMinutes()).padStart(2,"0")}` : "";
  meta.innerHTML = `
    <span>${entry.author ? escapeHtml(entry.author) : "작성자 미상"}</span>
    <span>${whenStr}</span>
    <span class="spacer"></span>
    <button class="icon-btn" data-act="edit">편집</button>
    <button class="icon-btn danger" data-act="del">삭제</button>
  `;
  meta.querySelector('[data-act="edit"]').addEventListener("click", () => {
    const next = prompt("상세내용 수정", entry.content);
    if (next !== null && next.trim()) updateL3(entry.id, next.trim());
  });
  meta.querySelector('[data-act="del"]').addEventListener("click", () => {
    if (confirm("이 상세내용을 삭제할까요?")) deleteL3(entry.id);
  });
  card.appendChild(meta);
  return card;
}

function escapeHtml(s){
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

/* ---- inline forms ---- */
function promptAddL1(){
  const name = prompt("새 프로젝트명 (예: GMCS project)");
  if (name && name.trim()) addL1(name.trim());
}
function promptAddL2(l1Id){
  const name = prompt("새 카테고리명 (예: 기획, 대시보드)");
  if (name && name.trim()) addL2(l1Id, name.trim());
}
function showAddEntryForm(container, addBtn, l2Id){
  if (container.querySelector(".inline-form")) return;
  addBtn.style.display = "none";

  const form = document.createElement("div");
  form.className = "inline-form";
  form.innerHTML = `
    <input type="text" placeholder="작성자 (선택)" class="author-input">
    <textarea placeholder="이번 주 진행 내용을 입력하세요..."></textarea>
    <div class="row">
      <button class="btn-sm save">저장</button>
      <button class="btn-sm cancel">취소</button>
    </div>
  `;
  container.insertBefore(form, addBtn);

  const textarea = form.querySelector("textarea");
  textarea.focus();

  form.querySelector(".save").addEventListener("click", async () => {
    const content = textarea.value.trim();
    const author = form.querySelector(".author-input").value.trim();
    if (!content) { textarea.focus(); return; }
    await addL3(l2Id, content, author);
    form.remove();
    addBtn.style.display = "";
  });
  form.querySelector(".cancel").addEventListener("click", () => {
    form.remove();
    addBtn.style.display = "";
  });
}
