// 캐릭터/무기/에코 목록(characters, weapons, echoes)은 js/data.js 에서 불러옴

function renderCharacterList() {
  const list = document.getElementById('characterList');
  list.innerHTML = characters.map(c => {
    const isTaken = selectedNames.has(c.name);
    return `
    <button onclick="selectCharacter('${c.name}')" ${isTaken ? 'disabled' : ''}
      class="text-left group ${isTaken ? 'opacity-30 cursor-not-allowed' : ''}">
      <div class="aspect-square rounded-lg overflow-hidden bg-zinc-800">
        <img src="${c.image}" class="w-full h-full object-cover ${isTaken ? '' : 'group-hover:scale-105'} transition-transform">
      </div>
      <div class="mt-1.5 text-sm font-bold text-zinc-100 truncate">${c.name}</div>
    </button>
  `;
  }).join('');
}

let activeSlot = null;
const totalSlots = ['spec-slot-1', 'spec-slot-2', 'spec-slot-3'];
const slotCharacter = {}; // 슬롯별로 어떤 캐릭터가 들어있는지 기록
const selectedNames = new Set(); // 이미 선택되어 다시 고를 수 없는 캐릭터 이름 모음

const characterDetailCache = {}; // id별 상세 데이터(스킬 계수 등) 캐시. 아직 data/characters/<id>.json이 없으면 null
const slotDetail = {}; // 슬롯별로 로드된 캐릭터 상세 데이터. 스킬 계수 UI가 생기면 여기서 꺼내 쓰면 됨
const slotWeapon = {}; // 슬롯별로 선택된 무기 id
const slotWeaponDetail = {}; // 슬롯별로 로드된 무기 상세 데이터. 무기 효과 UI가 생기면 여기서 꺼내 쓰면 됨

const slotEcho = {}; // 슬롯별 에코 5칸 정보. slotEcho[slotId][i] = { name, level } | null
let activeEchoSlot = null;
let activeEchoIndex = null;

async function loadCharacterDetail(id) {
  if (id in characterDetailCache) return characterDetailCache[id];
  let detail = null;
  try {
    const res = await fetch(`data/characters/${id}.json`);
    if (res.ok) detail = await res.json();
  } catch {
    detail = null;
  }
  characterDetailCache[id] = detail;
  return detail;
}

const weaponDetailCache = {}; // id별 무기 상세 데이터 캐시. 아직 data/weapons/<타입>/<id>.json이 없으면 null

async function loadWeaponDetail(id) {
  if (id in weaponDetailCache) return weaponDetailCache[id];
  let detail = null;
  try {
    const weapon = weapons.find(w => w.id === id);
    const folder = weapon ? weapon.weaponType : '';
    const res = await fetch(`data/weapons/${folder}/${id}.json`);
    if (res.ok) detail = await res.json();
  } catch {
    detail = null;
  }
  weaponDetailCache[id] = detail;
  return detail;
}

const echoDetailCache = {}; // id별 에코 상세 데이터 캐시. 아직 data/echoes/<id>.json이 없으면 null

async function loadEchoDetail(id) {
  if (id in echoDetailCache) return echoDetailCache[id];
  let detail = null;
  try {
    const res = await fetch(`data/echoes/${id}.json`);
    if (res.ok) detail = await res.json();
  } catch {
    detail = null;
  }
  echoDetailCache[id] = detail;
  return detail;
}

function openCharacterPicker(slotId) {
  activeSlot = slotId;
  const slotNumber = totalSlots.indexOf(slotId) + 1;
  document.getElementById('pickerTitle').innerText = slotNumber + '번 캐릭터 선택';
  document.getElementById('characterPickerModal').classList.remove('hidden');
  document.getElementById('characterSearchInput').value = '';
  renderCharacterList();
  filterCharacterList();
  document.getElementById('characterSearchInput').focus();
}

function closeCharacterPicker() {
  document.getElementById('characterPickerModal').classList.add('hidden');
  activeSlot = null;
}

// 작은 패널에 뜨는 항목들 — HP/공격력/방어력은 캐릭터별 baseStats에서, 나머지 3개는 COMMON_BASE_STATS에서 옴
const STAT_DETAIL_MAIN_FIELDS = [
  { label: 'HP', key: 'hp' },
  { label: '공격력', key: 'atk' },
  { label: '방어력', key: 'def' },
  { label: '공명 효율', key: 'energyRegen', percent: true },
  { label: '크리티컬', key: 'critRate', percent: true },
  { label: '크리티컬 피해', key: 'critDmg', percent: true },
];

// "···" 버튼을 눌러야만 보이는 나머지 항목들
const STAT_DETAIL_EXTRA_FIELDS = [
  { label: '공명 스킬 피해 보너스', key: 'skillDmgBonus', percent: true },
  { label: '일반 공격 피해 보너스', key: 'normalAtkDmgBonus', percent: true },
  { label: '강공격 피해 보너스', key: 'heavyAtkDmgBonus', percent: true },
  { label: '공명 해방 피해 보너스', key: 'liberationDmgBonus', percent: true },
];

function getStatDetailExtraFields(character) {
  const elementLabel = (character && character.element) ? character.element : '속성';
  return [
    ...STAT_DETAIL_EXTRA_FIELDS,
    { label: `${elementLabel} 피해 보너스`, key: 'elementDmgBonus', percent: true },
    { label: '치료 효과 보너스', key: 'healBonus', percent: true },
  ];
}

// 스탯 라벨(한글) → 내부 키 매핑. 4가지로 나뉨:
// - PERCENT_OF_BASE_TO_KEY: 'HP(%)'/'공격력(%)'/'방어력(%)' — 기본값(캐릭터+무기)에 곱해서 적용
// - FLAT_BONUS_TO_KEY: 순수 'HP'/'공격력'/'방어력' (에코 부옵션에만 있음, 무기엔 없음) — %적용 끝난 뒤에 더함
// - STAT_LABEL_TO_KEY: 크리티컬/크리티컬 피해/공명 효율 — 그 자체가 %단위 값이라 그냥 더함
// - EXTRA_STAT_LABEL_TO_KEY: 각종 피해 보너스류 — 마찬가지로 그냥 더함
const PERCENT_OF_BASE_TO_KEY = {
  'HP(%)': 'hp',
  '공격력(%)': 'atk',
  '방어력(%)': 'def',
};

const FLAT_BONUS_TO_KEY = {
  'HP': 'hp',
  '공격력': 'atk',
  '방어력': 'def',
};

const STAT_LABEL_TO_KEY = {
  '공명 효율': 'energyRegen',
  '크리티컬': 'critRate',
  '크리티컬 피해': 'critDmg',
};

const EXTRA_STAT_LABEL_TO_KEY = {
  '공명 스킬 피해 보너스': 'skillDmgBonus',
  '일반 공격 피해 보너스': 'normalAtkDmgBonus',
  '강공격 피해 보너스': 'heavyAtkDmgBonus',
  '공명 해방 피해 보너스': 'liberationDmgBonus',
  '치료 효과 보너스': 'healBonus',
  // 에코 주옵션의 속성별 피해 보너스는 캐릭터 속성이 하나뿐이므로 전부 elementDmgBonus 하나로 합침
  '용융 피해 보너스': 'elementDmgBonus',
  '응결 피해 보너스': 'elementDmgBonus',
  '전도 피해 보너스': 'elementDmgBonus',
  '기류 피해 보너스': 'elementDmgBonus',
  '회절 피해 보너스': 'elementDmgBonus',
  '인멸 피해 보너스': 'elementDmgBonus',
};

// 에코 주옵션/세트 효과의 '공격력'/'HP'/'방어력'은 실제로는 %증가라서, accumulateStat에 넘기기 전에
// (%) 붙은 타입으로 바꿔줌
const ECHO_PERCENT_STAT_ALIAS = { '공격력': '공격력(%)', 'HP': 'HP(%)', '방어력': '방어력(%)' };
function resolveEchoStatType(name) {
  return ECHO_PERCENT_STAT_ALIAS[name] || name;
}

// 무기 mainStat, 에코 부옵션 등 "라벨 + 수치" 형태의 보너스 하나를 base/percent/bonus/additive 중
// 맞는 버킷에 누적함. base는 나중에 (1 + percent%) 를 곱하고, bonus는 그 뒤에 그냥 더함.
function accumulateStat(type, value, percent, bonus, additive) {
  if (PERCENT_OF_BASE_TO_KEY[type]) {
    const key = PERCENT_OF_BASE_TO_KEY[type];
    percent[key] = (percent[key] || 0) + value;
  } else if (FLAT_BONUS_TO_KEY[type]) {
    const key = FLAT_BONUS_TO_KEY[type];
    bonus[key] = (bonus[key] || 0) + value;
  } else if (STAT_LABEL_TO_KEY[type]) {
    const key = STAT_LABEL_TO_KEY[type];
    additive[key] = (additive[key] || 0) + value;
  } else if (EXTRA_STAT_LABEL_TO_KEY[type]) {
    const key = EXTRA_STAT_LABEL_TO_KEY[type];
    additive[key] = (additive[key] || 0) + value;
  }
}

// 최종 스탯 = (캐릭터 기본 + 무기 기본 공격력) × (1 + 무기/에코 %보너스 합) + 에코 깡스탯 부옵션
function getMergedStats(slotId) {
  const baseStats = slotDetail[slotId] && slotDetail[slotId].baseStats;
  const weaponDetail = slotWeaponDetail[slotId];
  const echoList = slotEcho[slotId] || [];

  const base = {}; // %가 곱해지는 대상 (캐릭터 기본 스탯 + 무기 기본 공격력)
  const percent = {}; // HP(%)/공격력(%)/방어력(%) 보너스 합
  const bonus = {}; // 에코의 순수 HP/공격력/방어력 부옵션 — %와 무관하게 마지막에 더함
  const additive = { ...COMMON_BASE_STATS }; // 크리티컬류/각종 피해 보너스 — 그냥 다 더함

  if (baseStats) {
    if (baseStats.hp != null) base.hp = (base.hp || 0) + baseStats.hp;
    if (baseStats.atk != null) base.atk = (base.atk || 0) + baseStats.atk;
    if (baseStats.def != null) base.def = (base.def || 0) + baseStats.def;
  }
  if (weaponDetail && weaponDetail.baseAtk) {
    base.atk = (base.atk || 0) + weaponDetail.baseAtk;
  }
  if (weaponDetail && weaponDetail.mainStat) {
    accumulateStat(weaponDetail.mainStat.type, weaponDetail.mainStat.value, percent, bonus, additive);
  }

  // 에코 5칸: 주옵션(코스트별 고정 수치) + 보조 옵션(코스트별 고정, 선택 불필요) + 부옵션(최대 5개)을 모두 반영
  echoList.forEach(echo => {
    if (!echo) return;
    if (echo.mainStat && echo.cost) {
      const mainValue = (echoMainStatValuesByCost[echo.cost] || {})[echo.mainStat];
      if (mainValue != null) accumulateStat(resolveEchoStatType(echo.mainStat), mainValue, percent, bonus, additive);
    }
    const secondary = echoSecondaryStatByCost[echo.cost];
    if (secondary) accumulateStat(secondary.type, secondary.value, percent, bonus, additive);
    (echo.subStats || []).forEach(sub => {
      if (sub && sub.name && sub.value != null) accumulateStat(sub.name, sub.value, percent, bonus, additive);
    });
  });

  // 에코 세트 효과: 같은 세트를 2개 이상 장착하면 2세트 효과가 바로 적용됨
  // (3세트/5세트(+1세트) 효과는 발동 조건이 있어서 아직 미반영)
  const setCounts = {};
  echoList.forEach(echo => {
    if (echo && echo.setId) setCounts[echo.setId] = (setCounts[echo.setId] || 0) + 1;
  });
  Object.keys(setCounts).forEach(setId => {
    if (setCounts[setId] < 2) return;
    const setBonus = echoSetTwoPieceBonus[setId];
    if (setBonus) accumulateStat(resolveEchoStatType(setBonus.type), setBonus.value, percent, bonus, additive);
  });

  const stats = { ...additive };
  ['hp', 'atk', 'def'].forEach(key => {
    if (base[key] !== undefined || bonus[key] !== undefined) {
      stats[key] = (base[key] || 0) * (1 + (percent[key] || 0) / 100) + (bonus[key] || 0);
    }
  });

  return stats;
}

// 패시브 설명에서 {이름} 형태 placeholder를 재련(1~5)에 맞는 실제 수치로 치환
// valuesByRefinement가 배열이면(값이 하나뿐인 옛 형식) {value}만, 객체면({이름1: [...], 이름2: [...]}) 여러 개 지원
function renderWeaponPassiveText(passive, refinement) {
  if (!passive || !passive.description) return '';
  const idx = Math.max(1, Math.min(5, refinement || 1)) - 1;
  const values = passive.valuesByRefinement;

  return passive.description.replace(/\{(\w+)\}/g, (match, key) => {
    const arr = Array.isArray(values) ? (key === 'value' ? values : undefined) : (values && values[key]);
    return arr && arr[idx] !== undefined ? arr[idx] : match;
  });
}

function formatStatValue(stats, field) {
  const v = stats ? stats[field.key] : undefined;
  if (v === undefined || v === null) return '-';
  return field.percent ? `${v.toFixed(1)}%` : v.toLocaleString();
}

function renderStatDetail(slotId) {
  const container = document.getElementById(slotId.replace('spec-slot-', 'spec-detail-'));
  if (!container) return;

  const name = slotCharacter[slotId];
  if (!name) {
    container.innerHTML = '';
    return;
  }

  const stats = getMergedStats(slotId);

  container.innerHTML = `
    <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
      <div class="text-sm font-bold text-zinc-100 mb-2">${name} Lv. 90</div>
      <div class="space-y-1">
        ${STAT_DETAIL_MAIN_FIELDS.map(f => `
        <div class="flex justify-between items-center text-sm">
          <span class="text-zinc-400">${f.label}</span>
          <span class="text-zinc-200">${formatStatValue(stats, f)}</span>
        </div>
        `).join('')}
        <button type="button" onclick="openStatDetailMore('${slotId}')" class="w-full h-5 mt-1 flex items-center justify-center rounded-lg bg-zinc-800/50 border border-zinc-700 hover:border-teal-500 text-zinc-400 hover:text-zinc-200 text-sm leading-none tracking-widest transition-colors">
          ···
        </button>
      </div>
    </div>
  `;
}

function openStatDetailMore(slotId) {
  const name = slotCharacter[slotId];
  if (!name) return;

  const character = characters.find(c => c.name === name);
  const rows = [...STAT_DETAIL_MAIN_FIELDS, ...getStatDetailExtraFields(character)];
  const stats = getMergedStats(slotId);

  document.getElementById('statDetailTitle').textContent = `${name} Lv. 90`;
  document.getElementById('statDetailBody').innerHTML = rows.map(f => `
    <div class="flex justify-between items-center text-sm py-1.5 border-b border-zinc-800 last:border-b-0">
      <span class="text-zinc-400">${f.label}</span>
      <span class="text-zinc-200">${formatStatValue(stats, f)}</span>
    </div>
  `).join('');
  document.getElementById('statDetailModal').classList.remove('hidden');
}

function closeStatDetailModal() {
  document.getElementById('statDetailModal').classList.add('hidden');
}

function selectCharacter(name) {
  if (!activeSlot || selectedNames.has(name)) return;

  // 이 슬롯에 이미 다른 캐릭터가 있었다면 선택 가능 목록으로 되돌려줌
  const previous = slotCharacter[activeSlot];
  if (previous) selectedNames.delete(previous);

  slotCharacter[activeSlot] = name;
  selectedNames.add(name);

  const character = characters.find(c => c.name === name);
  const container = document.getElementById(activeSlot);
  slotEcho[activeSlot] = [null, null, null, null, null];

  // 왼쪽 위: 캐릭터 이미지(원래 크기 그대로, 1칸) / 오른쪽: 이름·레벨·무기 — 딱 이미지 높이만큼만, 그 안에서 균등 배분
  container.innerHTML = `
    <div class="grid grid-cols-2 grid-rows-2 h-full gap-2">
      <button onclick="openCharacterPicker('${activeSlot}')" class="p-1">
        <img src="${character.image}" class="w-full h-full object-cover rounded-md">
      </button>
      <div class="px-1 py-0.5 flex flex-col justify-between gap-0.5 overflow-y-auto">
        <div class="shrink-0 text-xs font-bold text-zinc-100 truncate mb-0.5">${name}</div>

        ${character.modes ? `
        <div class="shrink-0 grid grid-cols-${character.modes.length} gap-0.5">
          ${character.modes.map(m => `<button type="button" onclick="selectStatValue(this, 'mode')" data-value="${m}" class="stat-btn bg-zinc-800 border border-zinc-700 rounded text-[10px] text-zinc-300 py-0.5 hover:border-teal-500 transition-colors">${m}</button>`).join('')}
        </div>
        ` : ''}

        <div class="shrink-0 flex flex-col">
          <span class="text-[10px] text-zinc-400">돌파</span>
          <div class="grid grid-cols-7 gap-0.5">
            ${[0, 1, 2, 3, 4, 5, 6].map(b => `<button type="button" onclick="selectStatValue(this, 'breakthrough')" data-value="${b}" class="stat-btn rounded text-[10px] py-0.5 transition-colors ${b === 0 ? 'bg-teal-600 border border-teal-500 text-white' : 'bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-teal-500'}">${b}</button>`).join('')}
          </div>
        </div>

        <div class="shrink-0 flex flex-col">
          <span class="text-[10px] text-zinc-400">무기</span>
          <select onchange="selectWeapon(this, '${activeSlot}')" class="weapon-select w-full bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-200 focus:outline-none focus:border-teal-500">
            <option value="">무기 선택</option>
            ${weapons.filter(w => w.weaponType === character.weaponType).map(w => `<option value="${w.id}">${w.name} (★${w.rarity})</option>`).join('')}
          </select>
        </div>

        <div class="shrink-0 flex flex-col">
          <span class="text-[10px] text-zinc-400">재련</span>
          <div class="grid grid-cols-5 gap-0.5">
            ${[1, 2, 3, 4, 5].map(r => `<button type="button" onclick="selectStatValue(this, 'refinement')" data-value="${r}" class="stat-btn rounded text-[10px] py-0.5 transition-colors ${r === 1 ? 'bg-teal-600 border border-teal-500 text-white' : 'bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-teal-500'}">${r}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="p-1 h-full flex flex-col">
        <div class="shrink-0 text-xs font-bold text-zinc-100 mb-0.5">스킬</div>
        <div class="flex-1 grid grid-cols-5 gap-0.5">
          ${[0, 1, 2, 3, 4].map(() => `
          <div class="skill-col h-full flex flex-col items-center justify-between">
            <button type="button" onclick="toggleSkillNode(this, 'top')" class="skill-toggle w-full aspect-square rounded-full bg-zinc-800 border border-zinc-700 hover:border-teal-500 transition-colors"></button>
            <div class="w-px flex-1 bg-zinc-600"></div>
            <button type="button" onclick="toggleSkillNode(this, 'middle')" class="skill-toggle w-full aspect-square rounded-full bg-zinc-800 border border-zinc-700 hover:border-teal-500 transition-colors"></button>
            <div class="w-px flex-1 bg-zinc-600"></div>
            <select onchange="markPartyDirty()" class="w-full aspect-square appearance-none text-center bg-zinc-800 border border-zinc-700 rounded-full text-[9px] text-zinc-200 focus:outline-none focus:border-teal-500">
              ${Array.from({ length: 10 }, (_, i) => i + 1).map(lv => `<option value="${lv}">${lv}</option>`).join('')}
            </select>
          </div>
          `).join('')}
        </div>
      </div>
      <div class="p-1 h-full flex flex-col">
        <div class="shrink-0 text-xs font-bold text-zinc-100 mb-0.5">에코</div>
        <div id="${activeSlot}-echo-list" class="flex-1 flex flex-col gap-0.5">
          ${[0, 1, 2, 3, 4].map(i => renderEchoSlotHTML(activeSlot, i)).join('')}
        </div>
      </div>
    </div>
  `;

  // 캐릭터별 상세 데이터(스킬 계수 등)는 준비되는 대로 이 슬롯에 채워짐
  const slotId = activeSlot;
  loadCharacterDetail(character.id).then(detail => {
    slotDetail[slotId] = detail;
    renderStatDetail(slotId); // 로드가 끝나면 기본 스탯 수치로 다시 그림
  });

  closeCharacterPicker(); // 한 명 선택하면 바로 닫힘 (연속 선택 안 함)
  renderStatDetail(slotId);
  markPartyDirty();
}

function selectWeapon(select, slotId) {
  const weaponId = select.value;
  slotWeapon[slotId] = weaponId || null;
  markPartyDirty();
  if (!weaponId) {
    slotWeaponDetail[slotId] = null;
    renderStatDetail(slotId);
    return;
  }

  // 무기별 상세 데이터(효과 등)는 준비되는 대로 이 슬롯에 채워짐
  loadWeaponDetail(weaponId).then(detail => {
    slotWeaponDetail[slotId] = detail;
    renderStatDetail(slotId); // 로드가 끝나면 무기 보너스 반영해서 다시 그림
  });
}

function renderEchoSlotHTML(slotId, index) {
  const echo = (slotEcho[slotId] || [])[index];
  const label = echo ? [echo.setId, echo.mainStat].filter(Boolean).join(' · ') : '';
  return `<button type="button" onclick="openEchoEditor('${slotId}', ${index})" class="w-full flex-1 min-h-0 flex items-center justify-center px-1 bg-zinc-800 border border-zinc-700 rounded hover:border-teal-500 transition-colors text-[9px] text-zinc-200 truncate">${label}</button>`;
}

function renderEchoSlots(slotId) {
  const container = document.getElementById(slotId + '-echo-list');
  if (!container) return;
  container.innerHTML = [0, 1, 2, 3, 4].map(i => renderEchoSlotHTML(slotId, i)).join('');
}

let echoEditorDraft = null; // 모달에서 편집 중인 임시 상태. 완료를 눌러야 slotEcho에 반영됨

function emptyEchoDraft() {
  return { setId: '', cost: null, echoId: '', mainStat: '', subStats: [null, null, null, null, null] };
}

function openEchoEditor(slotId, index) {
  activeEchoSlot = slotId;
  activeEchoIndex = index;
  const existing = (slotEcho[slotId] || [])[index];
  echoEditorDraft = existing ? JSON.parse(JSON.stringify(existing)) : emptyEchoDraft();
  renderEchoEditorModal();
  document.getElementById('echoEditorModal').classList.remove('hidden');
}

function closeEchoEditor() {
  document.getElementById('echoEditorModal').classList.add('hidden');
  activeEchoSlot = null;
  activeEchoIndex = null;
  echoEditorDraft = null;
}

function saveEchoEditor() {
  if (activeEchoSlot === null) return;
  slotEcho[activeEchoSlot][activeEchoIndex] = echoEditorDraft;
  renderEchoSlots(activeEchoSlot);
  renderStatDetail(activeEchoSlot); // 에코 부옵션이 스탯에 바로 반영되게
  closeEchoEditor();
  markPartyDirty();
}

function clearEchoEditor() {
  if (activeEchoSlot === null) return;
  slotEcho[activeEchoSlot][activeEchoIndex] = null;
  renderEchoSlots(activeEchoSlot);
  renderStatDetail(activeEchoSlot);
  closeEchoEditor();
  markPartyDirty();
}

function getOtherEchoSlotsCostTotal() {
  const list = slotEcho[activeEchoSlot] || [];
  let total = 0;
  list.forEach((e, i) => {
    if (i !== activeEchoIndex && e && e.cost) total += e.cost;
  });
  return total;
}

function setEchoSet(setId) {
  echoEditorDraft.setId = setId;
  echoEditorDraft.echoId = ''; // 세트가 바뀌면 지금 고른 메인 에코는 더 이상 안 맞을 수 있으니 초기화
  renderEchoEditorModal();
}

function setEchoCost(cost) {
  echoEditorDraft.cost = cost;
  echoEditorDraft.echoId = ''; // 코스트가 바뀌어도 마찬가지
  // 코스트가 바뀌면 지금 주옵션이 그 코스트엔 없는 항목일 수 있으니 초기화
  if (!(echoMainStatsByCost[cost] || []).includes(echoEditorDraft.mainStat)) {
    echoEditorDraft.mainStat = '';
  }
  renderEchoEditorModal();
}

function setEchoSubStatName(i, name) {
  echoEditorDraft.subStats[i] = name ? { name, value: null } : null;
  renderEchoEditorModal();
}

function setEchoSubStatValue(i, value) {
  if (echoEditorDraft.subStats[i]) {
    echoEditorDraft.subStats[i].value = parseFloat(value);
  }
}

function renderEchoSubStatRow(i) {
  const row = echoEditorDraft.subStats[i];
  const usedElsewhere = echoEditorDraft.subStats
    .filter((s, idx) => idx !== i && s)
    .map(s => s.name);
  const nameOptions = echoSubStatNames.filter(n => !usedElsewhere.includes(n));
  const currentName = row ? row.name : '';

  return `
    <div class="flex gap-1">
      <select onchange="setEchoSubStatName(${i}, this.value)" class="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-teal-500">
        <option value="">부옵션 선택</option>
        ${nameOptions.map(n => `<option value="${n}" ${currentName === n ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
      <select onchange="setEchoSubStatValue(${i}, this.value)" ${!currentName ? 'disabled' : ''} class="w-24 shrink-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-teal-500 disabled:opacity-40">
        <option value="">수치</option>
        ${currentName ? echoSubStatValues[currentName].map(v => {
          const isFlat = ECHO_FLAT_SUBSTATS.includes(currentName);
          const label = isFlat ? v : v + '%';
          const selected = row && row.value === v ? 'selected' : '';
          return `<option value="${v}" ${selected}>${label}</option>`;
        }).join('') : ''}
      </select>
    </div>
  `;
}

function renderEchoEditorModal() {
  const isMainEcho = activeEchoIndex === 0;
  const otherTotal = getOtherEchoSlotsCostTotal();
  const budget = 12 - otherTotal;
  const draft = echoEditorDraft;

  document.getElementById('echoEditorBody').innerHTML = `
    <div>
      <label class="block text-xs text-zinc-400 mb-1">에코 세트</label>
      <select onchange="setEchoSet(this.value)" class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-teal-500">
        <option value="">세트 선택</option>
        ${echoSets.map(s => `<option value="${s}" ${draft.setId === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>

    <div>
      <label class="block text-xs text-zinc-400 mb-1">코스트 (5칸 합계 12 이하)</label>
      <div class="grid grid-cols-3 gap-1.5">
        ${[4, 3, 1].map(c => {
          const disabled = c > budget && draft.cost !== c;
          const active = draft.cost === c;
          return `<button type="button" ${disabled ? 'disabled' : ''} onclick="setEchoCost(${c})"
            class="py-2 rounded-lg text-sm border transition-colors ${active ? 'bg-teal-600 border-teal-500 text-white' : disabled ? 'bg-zinc-800/50 border-zinc-800 text-zinc-600 cursor-not-allowed' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-teal-500'}">${c}</button>`;
        }).join('')}
      </div>
      <div class="text-[10px] text-zinc-500 mt-1">현재 합계: ${otherTotal + (draft.cost || 0)} / 12</div>
    </div>

    ${isMainEcho ? `
    <div>
      <label class="block text-xs text-zinc-400 mb-1">메인 에코</label>
      <select onchange="echoEditorDraft.echoId = this.value" ${!draft.setId || !draft.cost ? 'disabled' : ''} class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-teal-500 disabled:opacity-40">
        <option value="">${!draft.setId || !draft.cost ? '세트·코스트를 먼저 선택하세요' : '에코 선택 (목록 추후 추가)'}</option>
        ${echoes.filter(e => e.setId === draft.setId && e.cost === draft.cost).map(e => `<option value="${e.id}" ${draft.echoId === e.id ? 'selected' : ''}>${e.name}</option>`).join('')}
      </select>
    </div>
    ` : ''}

    <div>
      <label class="block text-xs text-zinc-400 mb-1">주옵션</label>
      <select onchange="echoEditorDraft.mainStat = this.value" ${!draft.cost ? 'disabled' : ''} class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-teal-500 disabled:opacity-40">
        <option value="">${draft.cost ? '주옵션 선택' : '코스트를 먼저 선택하세요'}</option>
        ${(echoMainStatsByCost[draft.cost] || []).map(s => `<option value="${s}" ${draft.mainStat === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>

    <div>
      <label class="block text-xs text-zinc-400 mb-1">부옵션 (최대 5개, 중복 불가)</label>
      <div class="space-y-1">
        ${[0, 1, 2, 3, 4].map(i => renderEchoSubStatRow(i)).join('')}
      </div>
    </div>
  `;
}

function setSkillNodeActive(btn, active) {
  btn.classList.toggle('bg-teal-600', active);
  btn.classList.toggle('bg-zinc-800', !active);
  btn.classList.toggle('border-teal-500', active);
  btn.classList.toggle('border-zinc-700', !active);
}

function toggleSkillNode(btn, role) {
  const col = btn.closest('.skill-col');
  const [topBtn, midBtn] = col.querySelectorAll('.skill-toggle');

  const isActive = !btn.classList.contains('bg-teal-600');
  setSkillNodeActive(btn, isActive);

  // 맨 위를 켜면 가운데도 자동으로 같이 켜짐 (맨 위만 활성화되는 상태 방지)
  if (role === 'top' && isActive) {
    setSkillNodeActive(midBtn, true);
  }

  // 가운데를 끄면 맨 위도 같이 꺼짐
  if (role === 'middle' && !isActive) {
    setSkillNodeActive(topBtn, false);
  }
  markPartyDirty();
}

function selectStatValue(btn, type) {
  // 같은 그룹(돌파 또는 재련) 안에서 클릭한 버튼만 활성화 표시로 전환
  btn.parentElement.querySelectorAll('.stat-btn').forEach(b => {
    b.classList.remove('bg-teal-600', 'border-teal-500', 'text-white');
    b.classList.add('bg-zinc-800', 'border-zinc-700', 'text-zinc-300');
  });
  btn.classList.remove('bg-zinc-800', 'border-zinc-700', 'text-zinc-300');
  btn.classList.add('bg-teal-600', 'border-teal-500', 'text-white');
  markPartyDirty();
}

function filterCharacterList() {
  const keyword = document.getElementById('characterSearchInput').value.trim().toLowerCase();
  document.querySelectorAll('#characterList > button').forEach(btn => {
    const name = btn.innerText.toLowerCase();
    btn.classList.toggle('hidden', keyword !== '' && !name.includes(keyword));
  });
}

// ── 파티 저장 / 초기화 ─────────────────────────────────────

const PARTY_STORAGE_KEY = 'tethysys.parties';

function loadParties() {
  try {
    return JSON.parse(localStorage.getItem(PARTY_STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveParties(parties) {
  try {
    localStorage.setItem(PARTY_STORAGE_KEY, JSON.stringify(parties));
  } catch {
    // 저장 공간이 꽉 찼거나 접근이 막혀도 앱이 죽지 않게 조용히 무시
  }
}

function getInitialLetter(characterName) {
  // 방랑자는 이름 앞글자('방') 대신 [ ] 안 속성의 앞글자를 씀
  const roverMatch = characterName.match(/^방랑자\s*\[(.+?)\]/);
  if (roverMatch) return roverMatch[1].charAt(0);
  return characterName.charAt(0);
}

function ensureUniquePartyName(base) {
  const existingNames = new Set(loadParties().map(p => p.name));
  if (!existingNames.has(base)) return base;
  let i = 2;
  while (existingNames.has(base + i)) i++;
  return base + i;
}

function generatePartyDefaultName() {
  const letters = totalSlots
    .map(slotId => slotCharacter[slotId])
    .filter(Boolean)
    .map(getInitialLetter);
  return ensureUniquePartyName(letters.join('') || '파티');
}

function captureSlotState(slotId) {
  const name = slotCharacter[slotId];
  if (!name) return null;

  const container = document.getElementById(slotId);
  const character = characters.find(c => c.name === name);

  const getActiveStatValue = (type) => {
    const btn = container.querySelector(`.stat-btn[onclick*="'${type}'"].bg-teal-600`);
    return btn ? btn.dataset.value : null;
  };

  const skills = [...container.querySelectorAll('.skill-col')].map(col => {
    const [topBtn, midBtn] = col.querySelectorAll('.skill-toggle');
    const select = col.querySelector('select');
    return {
      top: topBtn.classList.contains('bg-teal-600'),
      middle: midBtn.classList.contains('bg-teal-600'),
      level: select ? parseInt(select.value, 10) : 1,
    };
  });

  return {
    characterId: character ? character.id : null,
    characterName: name,
    mode: getActiveStatValue('mode'),
    breakthrough: getActiveStatValue('breakthrough'),
    refinement: getActiveStatValue('refinement'),
    weaponId: slotWeapon[slotId] || null,
    skills,
    echoes: slotEcho[slotId] || [null, null, null, null, null],
  };
}

// 현재 화면 상태가 저장된 어떤 파티에서 왔는지 + 그 뒤로 손댔는지 추적
let currentPartyName = null;
let isPartyDirty = false;
let suppressDirtyTracking = false; // 파티 불러오는 중엔 markPartyDirty가 무시되게

function markPartyDirty() {
  if (suppressDirtyTracking) return;
  if (currentPartyName && !isPartyDirty) {
    isPartyDirty = true;
    renderPartyStatusBar();
  }
}

function renderPartyStatusBar() {
  document.getElementById('currentPartyLabel').textContent = currentPartyName || '';
  document.getElementById('partyUpdateBtn').classList.toggle('hidden', !(currentPartyName && isPartyDirty));
}

function openPartySaveBar() {
  document.getElementById('partySaveOpenBtn').classList.add('hidden');
  const bar = document.getElementById('partySaveBar');
  bar.classList.remove('hidden');
  bar.classList.add('flex');
  const input = document.getElementById('partyNameInput');
  input.value = generatePartyDefaultName();
  input.focus();
  input.select();
}

function cancelPartySave() {
  document.getElementById('partySaveBar').classList.add('hidden');
  document.getElementById('partySaveBar').classList.remove('flex');
  document.getElementById('partySaveOpenBtn').classList.remove('hidden');
}

function confirmPartySave() {
  const slotStates = totalSlots.map(captureSlotState).filter(Boolean);
  if (slotStates.length === 0) {
    cancelPartySave();
    return; // 캐릭터가 하나도 없으면 저장할 게 없음
  }

  const typedName = document.getElementById('partyNameInput').value.trim();
  const name = ensureUniquePartyName(typedName || generatePartyDefaultName());

  const parties = loadParties();
  parties.push({ name, characters: slotStates, savedAt: Date.now() });
  saveParties(parties);

  currentPartyName = name;
  isPartyDirty = false;
  cancelPartySave();
  renderPartyStatusBar();
  renderPartyList();
}

function updateCurrentParty() {
  if (!currentPartyName) return;
  const parties = loadParties();
  const idx = parties.findIndex(p => p.name === currentPartyName);
  if (idx === -1) return;

  parties[idx].characters = totalSlots.map(captureSlotState).filter(Boolean);
  parties[idx].savedAt = Date.now();
  saveParties(parties);

  isPartyDirty = false;
  renderPartyStatusBar();
}

function deleteParty(name, event) {
  event.stopPropagation(); // 파티 불러오기가 같이 실행되지 않게
  saveParties(loadParties().filter(p => p.name !== name));

  if (currentPartyName === name) {
    currentPartyName = null;
    isPartyDirty = false;
    renderPartyStatusBar();
  }
  renderPartyList();
}

let partyListExpanded = false;
const PARTY_LIST_COLLAPSED_COUNT = 6;

function togglePartyListExpanded() {
  partyListExpanded = !partyListExpanded;
  renderPartyList();
}

function renderPartyList() {
  const parties = loadParties();
  const section = document.getElementById('partyListSection');
  const pills = document.getElementById('partyListPills');

  if (parties.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  const visible = partyListExpanded ? parties : parties.slice(0, PARTY_LIST_COLLAPSED_COUNT);

  pills.innerHTML = visible.map(p => {
    const safeName = p.name.replace(/'/g, "\\'");
    return `
      <button onclick="loadParty('${safeName}')" class="flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 hover:border-teal-500 rounded-full pl-3 pr-1.5 py-1 text-xs text-zinc-200 transition-colors">
        <span>${p.name}</span>
        <span onclick="deleteParty('${safeName}', event)" class="text-zinc-500 hover:text-red-400 px-1">×</span>
      </button>
    `;
  }).join('');

  if (parties.length > PARTY_LIST_COLLAPSED_COUNT) {
    pills.innerHTML += `
      <button onclick="togglePartyListExpanded()" class="text-xs text-zinc-500 hover:text-zinc-300 px-2 py-1">
        ${partyListExpanded ? '접기' : `펼치기 (+${parties.length - PARTY_LIST_COLLAPSED_COUNT})`}
      </button>
    `;
  }
}

function applySlotState(slotId, state) {
  activeSlot = slotId;
  selectCharacter(state.characterName);

  const container = document.getElementById(slotId);

  const setActiveStat = (type, value) => {
    if (value === null || value === undefined) return;
    const btn = container.querySelector(`.stat-btn[onclick*="'${type}'"][data-value="${value}"]`);
    if (btn) selectStatValue(btn, type);
  };
  setActiveStat('mode', state.mode);
  setActiveStat('breakthrough', state.breakthrough);
  setActiveStat('refinement', state.refinement);

  if (state.weaponId) {
    const weaponSelect = container.querySelector('.weapon-select');
    if (weaponSelect) {
      weaponSelect.value = state.weaponId;
      selectWeapon(weaponSelect, slotId);
    }
  }

  const skillCols = container.querySelectorAll('.skill-col');
  (state.skills || []).forEach((skillState, i) => {
    const col = skillCols[i];
    if (!col || !skillState) return;
    const [topBtn, midBtn] = col.querySelectorAll('.skill-toggle');
    setSkillNodeActive(midBtn, !!skillState.middle);
    setSkillNodeActive(topBtn, !!skillState.top);
    const levelSelect = col.querySelector('select');
    if (levelSelect && skillState.level) levelSelect.value = skillState.level;
  });

  slotEcho[slotId] = state.echoes ? JSON.parse(JSON.stringify(state.echoes)) : [null, null, null, null, null];
  renderEchoSlots(slotId);
}

function loadParty(name) {
  const party = loadParties().find(p => p.name === name);
  if (!party) return;

  suppressDirtyTracking = true;
  resetCharacterSetup();
  party.characters.forEach((state, i) => {
    const slotId = totalSlots[i];
    if (slotId && state) applySlotState(slotId, state);
  });
  suppressDirtyTracking = false;

  currentPartyName = party.name;
  isPartyDirty = false;
  renderPartyStatusBar();
}

function resetCharacterSetup() {
  totalSlots.forEach(slotId => {
    const name = slotCharacter[slotId];
    if (name) selectedNames.delete(name);
    delete slotCharacter[slotId];
    delete slotWeapon[slotId];
    delete slotWeaponDetail[slotId];
    delete slotDetail[slotId];
    delete slotEcho[slotId];

    document.getElementById(slotId).innerHTML = `
      <button onclick="openCharacterPicker('${slotId}')" class="w-full h-full flex items-center justify-center text-2xl text-zinc-600 hover:text-teal-400 border-2 border-dashed border-zinc-700 hover:border-teal-500 rounded-lg transition-colors">
        ＋
      </button>
    `;
    renderStatDetail(slotId);
  });

  cancelPartySave();
  currentPartyName = null;
  isPartyDirty = false;
  renderPartyStatusBar();
}

renderCharacterList();
renderPartyList();
renderPartyStatusBar();

// 모달은 배경 클릭으로도 닫히게 해뒀고(각 모달 div의 onclick), Esc는 여기서 한 번에 처리
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.getElementById('characterPickerModal').classList.contains('hidden')) closeCharacterPicker();
  if (!document.getElementById('echoEditorModal').classList.contains('hidden')) closeEchoEditor();
  if (!document.getElementById('statDetailModal').classList.contains('hidden')) closeStatDetailModal();
});
