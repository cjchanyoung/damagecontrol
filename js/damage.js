// 데미지 계산 엔진. DOM을 전혀 모르고 순수 계산만 함 — 스탯/스킬/적 설정만 넘기면 숫자가 나옴.
// 화면과 상태 관리는 js/main.js 담당.
//
// 공식:
//   피해 = 공격력 × 계수 × 피해 증가 × 피해 부스트 × 크리티컬 × 방어력 × 저항
//
//   공격력      = (기본 + 무기) × 공퍼 + 깡공          ← main.js의 getMergedStats가 이미 이렇게 계산함
//   계수        = (스킬 계수 + 배율 가산) × (1 + 추가 배율)
//   피해 증가   = 1 + 속성 피해 증가 + 스킬 피해 증가   ← 전부 덧셈
//   피해 부스트 = 1 + 피해 부스트                       ← 위와 별도로 곱해짐
//   크리티컬    = 크리 × 크리피 + (1 - 크리)
//   방어력      = 1 - 적방 / (적방 + 800 + 8 × 캐릭터 레벨)
//   저항        = 1 - 적 저항

// 스킬 트리 5열. 이 순서가 캐릭터 카드의 스킬 5칸(왼→오)과 1:1로 대응됨.
// outro(반주 스킬)는 트리에 열이 없어서 레벨도 없음 — 그래서 SKILL_TREE_ORDER엔 안 들어감.
const SKILL_TREE_ORDER = ['normal', 'skill', 'liberation', 'intro', 'circuit'];
const SKILL_GROUP_ORDER = [...SKILL_TREE_ORDER, 'outro'];
const SKILL_GROUP_LABEL = {
  normal: '기본 공격', skill: '공명 스킬', liberation: '공명 해방',
  intro: '변주 스킬', circuit: '공명 회로', outro: '반주 스킬',
};

// 피해 판정(damageType) → 스킬 피해 보너스 스탯 키. null이면 해당 보너스가 없는 판정.
const TYPE_BONUS_KEY = {
  normal: 'normalAtkDmgBonus',
  heavy: 'heavyAtkDmgBonus',
  skill: 'skillDmgBonus',
  liberation: 'liberationDmgBonus',
  echo: 'echoAbilityDmgBonus',
  intro: null,
  outro: null,
  // 조화도 피해는 전용 '피해 보너스' 스탯이 따로 없어서 null.
  // (조화도 파괴 증폭 concertoAmp가 이 피해에 어떻게 곱해지는지는 아직 공식 미정 — 확인 후 반영 필요)
  concerto: null,
};
const TYPE_LABEL = {
  normal: '일반공격', heavy: '강공격', skill: '공명스킬', liberation: '공명해방',
  intro: '변주', outro: '반주', echo: '에코', concerto: '조화도',
};

// 피해 유형별 고유 색. 파이차트 조각과 범례가 같은 값을 쓰도록 여기서만 관리함.
// (Tailwind 클래스는 SVG fill에 안 먹어서 hex로 둠)
const TYPE_COLOR = {
  normal: '#38bdf8',     // 일반 — 하늘
  heavy: '#f59e0b',      // 강공 — 주황
  skill: '#14b8a6',      // 스킬 — 청록
  liberation: '#a855f7', // 해방 — 보라
  intro: '#22c55e',      // 변주 — 초록
  outro: '#f43f5e',      // 반주 — 분홍
  echo: '#e879f9',       // 에코 — 자홍
  concerto: '#6366f1',   // 조화도 — 남보라
  etc: '#71717a',
};

// 속성 → 속성 피해 보너스 스탯 키. 'physical'(물리)은 속성 피해 보너스를 못 받음.
const ELEMENT_BONUS_KEY = {
  '응결': 'glacioDmgBonus',
  '용융': 'fusionDmgBonus',
  '전도': 'electroDmgBonus',
  '기류': 'aeroDmgBonus',
  '회절': 'spectroDmgBonus',
  '인멸': 'havocDmgBonus',
  'physical': null,
};

// 버프 effects의 stat 키 → 어느 버킷에 들어가는지.
// - PERCENT_EFFECT_KEYS: 기본값(캐릭터+무기)에 곱해지는 %증가
// - FLAT_EFFECT_KEYS: %가 다 끝난 뒤에 더해지는 깡스탯
// - 그 외: 전부 그냥 더해짐 (critRate/critDmg/각종 피해 보너스 + 아래 DAMAGE_ONLY_STATS)
const PERCENT_EFFECT_KEYS = { atkPercent: 'atk', hpPercent: 'hp', defPercent: 'def' };
const FLAT_EFFECT_KEYS = { atkFlat: 'atk', hpFlat: 'hp', defFlat: 'def' };

// 스탯 패널엔 안 나오고 데미지 계산에만 쓰이는 값들.
// mvFlat/mvBoost/dmgBoost는 다른 보너스와 곱해지는 자리가 달라서 절대 같이 더하면 안 됨.
const DAMAGE_ONLY_STATS = {
  dmgBonus: '피해 증가(전체)',
  dmgBoost: '피해 부스트',
  mvFlat: '피해 배율 가산(%p)',
  mvBoost: '추가 배율',
  defIgnore: '방어력 무시',
  defShred: '방어력 감소',
  resShred: '저항 감소',
};

// 적 방어력 = 8 × 적 레벨 + 792, 방어력 계수의 상수항 = 800 + 8 × 캐릭터 레벨.
// 커뮤니티에서 통용되는 값이라 실제 인게임 수치로 검증 필요 — 그래서 상수로 빼둠.
const ENEMY_DEF_PER_LEVEL = 8;
const ENEMY_DEF_BASE = 792;
const DEF_CONST_BASE = 800;
const DEF_CONST_PER_LEVEL = 8;
const DEFAULT_CHAR_LEVEL = 90;

function clampSkillLevel(level) {
  return Math.max(1, Math.min(10, level || 10));
}

// 한 판정(part)의 계수. mvByLevel이 있으면 스킬 레벨에 맞는 값을, 없으면 mv를 그대로 씀.
function resolvePartMv(part, level) {
  const mv = Array.isArray(part.mvByLevel) ? part.mvByLevel[clampSkillLevel(level) - 1] : part.mv;
  return (mv || 0) * (part.hits || 1);
}

// 스킬 하나의 기본 계수 합 (23.60%*7 + 153.45%*2 처럼 여러 파트면 다 더함)
function entryBaseMv(entry, level) {
  return (entry.parts || []).reduce((sum, p) => sum + resolvePartMv(p, level), 0);
}

// scope가 있는 효과가 이 스킬에 적용되는지
function matchScope(scope, entry) {
  if (!scope) return true;
  if (scope.skillIds && !scope.skillIds.includes(entry.id)) return false;
  if (scope.damageTypes && !(entry.damageType || []).some(t => scope.damageTypes.includes(t))) return false;
  return true;
}

function scopedSum(scoped, stat, entry) {
  return (scoped || []).reduce(
    (sum, e) => (e.stat === stat && matchScope(e.scope, entry) ? sum + e.value : sum), 0);
}

// 캐릭터 상세 데이터의 skills를 화면에 뿌리기 좋은 평평한 배열로 펼침.
// 각 항목에 자기가 속한 트리(tree)를 붙여줘서 스킬 레벨을 찾아갈 수 있게 함.
function flattenSkillEntries(detail) {
  const skills = (detail && detail.skills) || {};
  const rows = [];
  SKILL_GROUP_ORDER.forEach(tree => {
    const group = skills[tree];
    if (!group) return;
    (group.entries || []).forEach(entry => {
      rows.push({ ...entry, tree, treeName: group.name || SKILL_GROUP_LABEL[tree] });
    });
  });
  return rows;
}

// 버프 descriptor(무기/에코/체인/노드/캐릭터 공통)를 계산하기 쉬운 형태로 정규화.
// index는 재련(1~5)처럼 값이 배열로 들어오는 소스에서 몇 번째를 쓸지.
function normalizeBuff(buff, id, label, options) {
  const opts = options || {};
  const idx = opts.index || 0;
  const trigger = buff.trigger || {};
  const stacks = buff.stacks || {};
  const maxStacks = stacks.max || 1;
  return {
    id,
    label: label || buff.label || buff.id || id,
    condition: buff.condition || '',
    target: buff.target || 'self',
    toggleable: trigger.mode !== 'always',
    defaultOn: trigger.default !== false,
    maxStacks,
    defaultStacks: Math.min(maxStacks, stacks.default || maxStacks),
    effects: (buff.effects || []).map(e => ({
      stat: e.stat,
      value: Array.isArray(e.value) ? (e.value[idx] || 0) : (e.value || 0),
      scope: e.scope || null,
    })),
  };
}

// 효과 하나를 percent/bonus/additive 버킷 중 맞는 곳에 누적
function applyEffect(effect, percent, bonus, additive) {
  const stat = effect.stat;
  const value = effect.value;
  if (PERCENT_EFFECT_KEYS[stat]) {
    const key = PERCENT_EFFECT_KEYS[stat];
    percent[key] = (percent[key] || 0) + value;
  } else if (FLAT_EFFECT_KEYS[stat]) {
    const key = FLAT_EFFECT_KEYS[stat];
    bonus[key] = (bonus[key] || 0) + value;
  } else {
    additive[stat] = (additive[stat] || 0) + value;
  }
}

// 로테이션 한 바퀴를 돌려서 총 딜량 / 유형별 비율 / 스텝별 내역을 냄.
// rotation.steps의 한 칸은 셋 중 하나:
//   { pending: true, note }                     — 아직 계산 못 하는 자리(에코 등). 표시만 되고 딜엔 안 들어감
//   { skillId, count }                          — 스킬 하나를 count번
//   { repeat, skillIds: [...] }                 — 여러 스킬을 한 묶음으로 repeat번 반복
function computeRotation(rotation, entriesById, ctx) {
  const rows = [];
  const byType = {};
  let total = 0;

  (rotation.steps || []).forEach(step => {
    if (step.pending) {
      rows.push({ pending: true, note: step.note || '' });
      return;
    }

    const ids = step.skillIds || (step.skillId ? [step.skillId] : []);
    const count = (step.repeat || 1) * (step.count || 1);

    ids.forEach((id, i) => {
      const entry = entriesById[id];
      if (!entry) {
        rows.push({ missing: true, note: i === 0 ? step.note : '', label: id });
        return;
      }
      const dmg = computeEntryDamage(entry, ctx);
      const sum = dmg.avg * count;
      total += sum;

      // 유형 비율은 첫 번째 판정을 대표로 씀 (해방인데 강공격 판정이면 '강공'으로 집계)
      const type = (entry.damageType || [])[0] || 'etc';
      byType[type] = (byType[type] || 0) + sum;

      rows.push({ entry, count, each: dmg.avg, sum, dmg, note: i === 0 ? step.note : '' });
    });
  });

  const types = Object.keys(byType)
    .map(type => ({ type, sum: byType[type], ratio: total > 0 ? byType[type] / total : 0 }))
    .sort((a, b) => b.sum - a.sum);

  return { rows, total, types };
}

// 스킬 하나의 피해. ctx = { stats, scoped, enemy, element, charLevel, skillLevels }
function computeEntryDamage(entry, ctx) {
  const stats = ctx.stats || {};
  const scoped = ctx.scoped || [];
  const enemy = ctx.enemy || { level: 90, res: 0 };
  const charLevel = ctx.charLevel || DEFAULT_CHAR_LEVEL;
  const level = (ctx.skillLevels || {})[entry.tree];
  const element = (!entry.element || entry.element === 'inherit') ? ctx.element : entry.element;

  // 계수 = (스킬 계수 + 배율 가산) × (1 + 추가 배율)
  const baseMv = entryBaseMv(entry, level);
  const mvFlat = (stats.mvFlat || 0) + scopedSum(scoped, 'mvFlat', entry);
  const mvBoost = 1 + ((stats.mvBoost || 0) + scopedSum(scoped, 'mvBoost', entry)) / 100;
  const mv = (baseMv + mvFlat) * mvBoost;

  // 공격력 (방어력/HP 계수 캐릭터면 scaling으로 바꿔 씀)
  const scalingStat = entry.scaling || 'atk';
  const atk = stats[scalingStat] || 0;

  // 피해 증가 = 1 + 속성 + 스킬 판정별 보너스 (전부 덧셈)
  let inc = (stats.dmgBonus || 0) + scopedSum(scoped, 'dmgBonus', entry);
  const elementKey = ELEMENT_BONUS_KEY[element];
  if (elementKey) inc += stats[elementKey] || 0;
  (entry.damageType || []).forEach(t => {
    const key = TYPE_BONUS_KEY[t];
    if (key) inc += stats[key] || 0;
  });
  const dmgInc = 1 + inc / 100;

  // 피해 부스트 (별도 곱)
  const dmgBoost = 1 + ((stats.dmgBoost || 0) + scopedSum(scoped, 'dmgBoost', entry)) / 100;

  // 크리티컬
  const critRate = Math.max(0, Math.min(100, stats.critRate || 0)) / 100;
  const critDmg = (stats.critDmg || 0) / 100;
  const critAvg = critRate * critDmg + (1 - critRate);

  // 방어력
  const enemyDef = (ENEMY_DEF_PER_LEVEL * enemy.level + ENEMY_DEF_BASE)
    * Math.max(0, 1 - ((stats.defIgnore || 0) + (stats.defShred || 0)) / 100);
  const defTerm = 1 - enemyDef / (enemyDef + DEF_CONST_BASE + DEF_CONST_PER_LEVEL * charLevel);

  // 저항
  const resTerm = 1 - ((enemy.res || 0) - (stats.resShred || 0)) / 100;

  const common = atk * (mv / 100) * dmgInc * dmgBoost * defTerm * resTerm;

  return {
    nonCrit: common,
    crit: common * critDmg,
    avg: common * critAvg,
    breakdown: {
      atk: atk, baseMv: baseMv, mvFlat: mvFlat, mvBoost: mvBoost, mv: mv,
      dmgInc: dmgInc, dmgIncSum: inc, dmgBoost: dmgBoost,
      critRate: critRate * 100, critDmg: critDmg * 100, critAvg: critAvg,
      enemyDef: enemyDef, defTerm: defTerm, resTerm: resTerm,
    },
  };
}
