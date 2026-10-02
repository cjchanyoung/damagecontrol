// encore.moe의 게임 원본 데이터 API에서 캐릭터 스킬 데이터를 받아 data/characters/<id>.json 으로 변환한다.
//
//   node tools/import-encore.js            → 전체 캐릭터 비교만 (파일 안 씀)
//   node tools/import-encore.js --write    → 실제로 파일에 씀
//   node tools/import-encore.js 기염       → 특정 캐릭터만 (이름 일부로 필터)
//
// 기계적으로 확실한 것만 생성하고(계수/판정/스케일링/연결점/체인 원문),
// 판단이 필요한 buffs·rotation은 기존 파일 값을 그대로 보존한다.
// 기존 파일에 이미 skills가 손으로 작성돼 있으면(= 큐레이션 완료) 건드리지 않고 비교 결과만 알려준다.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = 'https://api.encore.moe/ko/character';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const FORCE = args.includes('--force'); // 손으로 쓴 skills까지 덮어씀 (기본은 보존)
const filter = args.find(a => !a.startsWith('--'));

// ── 매핑 테이블 ────────────────────────────────────────────

// encore의 SkillType → 우리 스킬 트리 키
const TREE_BY_SKILL_TYPE = {
  '기본 공격': 'normal',
  '공명 스킬': 'skill',
  '공명 해방': 'liberation',
  '변주 스킬': 'intro',
  '공명 회로': 'circuit',
  '반주 스킬': 'outro',
};

// DamageList의 Type(게임 자체 판정 분류) → 우리 damageType
const DAMAGE_TYPE_BY_NAME = {
  '일반 공격': 'normal',
  '강공격': 'heavy',
  '공명 스킬': 'skill',
  '공명 해방': 'liberation',
  '변주 스킬': 'intro',
  '반주 스킬': 'outro',
  '에코 스킬': 'echo',
  '에코 어빌리티': 'echo',
  '조화도 파괴': 'concerto',
};

// 위 표에 정확히 없을 때 쓰는 보조 규칙. 「조화 파동 · 이탈」처럼 괄호/변형이 붙은 이름을 걸러냄.
function resolveDamageType(rawType) {
  const raw = String(rawType || '').trim();
  if (!raw) return null;
  if (DAMAGE_TYPE_BY_NAME[raw]) return DAMAGE_TYPE_BY_NAME[raw];
  const plain = raw.replace(/[「」·\s]/g, '');
  if (plain.includes('조화')) return 'concerto';
  if (plain.includes('에코')) return 'echo';
  if (plain.includes('강공격')) return 'heavy';
  if (plain.includes('일반공격')) return 'normal';
  return null;
}

// DamageList의 PropertyName → 계수를 곱할 스탯
const SCALING_BY_PROPERTY = {
  '공격력': 'atk',
  'HP': 'hp',
  '생명력': 'hp',
  '방어력': 'def',
};

// 연결점 설명문 → 효과 키. 긴 이름을 먼저 둬야 함('크리티컬 피해'가 '크리티컬'보다 먼저)
const NODE_STAT_PATTERNS = [
  ['크리티컬 피해', 'critDmg'],
  ['크리티컬', 'critRate'],
  ['공명 효율', 'energyRegen'],
  ['일반 공격 피해 보너스', 'normalAtkDmgBonus'],
  ['강공격 피해 보너스', 'heavyAtkDmgBonus'],
  ['공명 스킬 피해 보너스', 'skillDmgBonus'],
  ['공명 해방 피해 보너스', 'liberationDmgBonus'],
  ['에코 어빌리티 피해 보너스', 'echoAbilityDmgBonus'],
  ['치료 효과 보너스', 'healBonus'],
  ['응결 피해 보너스', 'glacioDmgBonus'],
  ['용융 피해 보너스', 'fusionDmgBonus'],
  ['전도 피해 보너스', 'electroDmgBonus'],
  ['기류 피해 보너스', 'aeroDmgBonus'],
  ['회절 피해 보너스', 'spectroDmgBonus'],
  ['인멸 피해 보너스', 'havocDmgBonus'],
  ['공격력', 'atkPercent'],
  ['방어력', 'defPercent'],
  ['HP', 'hpPercent'],
];

// SkillTree의 수치 노드 8개를 붙일 트리 순서.
// tier1 4개 + tier2 4개가 같은 순서로 대응된다고 보고 짝지음 (기염 실데이터와 일치 확인).
// 합계에는 영향이 없고(같은 값끼리 쌍을 이룸) 어느 칸 토글이 어느 보너스를 켜는지만 달라짐.
const NODE_TREE_ORDER = ['normal', 'skill', 'liberation', 'intro'];

// ── 유틸 ──────────────────────────────────────────────────

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normName(s) {
  return String(s || '').replace(/[\s·:[\]]/g, '');
}

function num(s) {
  const m = String(s).match(/-?[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

// "23.60%*7+153.45%*2" → [{mv:23.6,hits:7},{mv:153.45,hits:2}]
function parseParts(value) {
  const parts = [];
  for (const chunk of String(value).split('+')) {
    const m = chunk.match(/([\d.]+)\s*%\s*(?:\*\s*(\d+))?/);
    if (!m) continue;
    const part = { mv: parseFloat(m[1]) };
    if (m[2]) part.hits = parseInt(m[2], 10);
    parts.push(part);
  }
  return parts;
}

// 계수 행인지 (쿨타임/스태미나/에너지/지속시간 등을 걸러냄)
function isDamageAttribute(attr) {
  const name = String(attr.attributeName || '');
  const v = String((attr.values || [])[0] || '');
  if (!v.includes('%')) return false;
  if (!name.includes('피해')) return false;
  if (name.includes('보너스') || name.includes('감소') || name.includes('저항')) return false;
  // '피해 증가(HP 최대치 1000 당)', '1pt 당 피해 배율 증가량' 같은 행은 스킬 계수가 아니라 버프 수치
  if (name.includes('증가') || name.includes('배율') || name.includes('당)') || name.includes(' 당')) return false;
  return true;
}

// DamageList의 RateLv(레벨 1~10 문자열 배열) → 숫자 배열. 전부 같으면 null.
function rate10(rate) {
  const nums = (rate || []).slice(0, 10).map(v => num(v));
  if (nums.length < 10 || nums.some(n => n === null)) return null;
  if (nums.every(n => n === nums[0])) return null;
  return nums;
}

// 레벨 1~10 계수 배열. 전부 같으면 null을 돌려서 스칼라 mv만 쓰게 함.
function levelArray(attr) {
  const values = (attr.values || []).slice(0, 10);
  if (values.length < 10) return null;
  const nums = values.map(v => num(v));
  if (nums.some(n => n === null)) return null;
  if (nums.every(n => n === nums[0])) return null;
  return nums;
}

// 이 계수를 내는 DamageList 항목을 찾아 판정/스케일링 스탯을 알아냄
function findDamageMeta(damageList, mv) {
  for (const d of damageList || []) {
    const rate = d.RateLv || [];
    const last = num(rate[rate.length - 1]);
    if (last !== null && Math.abs(last - mv) < 0.011) {
      return {
        type: resolveDamageType(d.Type),
        scaling: SCALING_BY_PROPERTY[d.PropertyName] || null,
        rawType: d.Type,
        rawProperty: d.PropertyName,
      };
    }
  }
  return null;
}

// 판정을 못 알아낸 경우의 기본값. 'circuit'은 피해 판정이 아니라서 일반 공격으로 떨어뜨림.
const VALID_DAMAGE_TYPES = ['normal', 'heavy', 'skill', 'liberation', 'intro', 'outro', 'echo', 'concerto'];
function fallbackDamageType(tree) {
  return VALID_DAMAGE_TYPES.includes(tree) ? tree : 'normal';
}

function nodeEffects(describe) {
  const text = stripHtml(describe);
  for (const [word, stat] of NODE_STAT_PATTERNS) {
    if (!text.includes(word)) continue;
    const v = num(text.slice(text.indexOf(word) + word.length));
    if (v === null) continue;
    return [{ stat, value: v }];
  }
  return null;
}

// ── 변환 ──────────────────────────────────────────────────

function buildCharacter(api, warnings, label) {
  const skills = {};
  const innate = [];
  // 어떤 판정이 다른 스킬의 DamageList에 등록돼 있는 경우가 있어서 캐릭터 전체를 합쳐둠
  const allDamage = (api.Skills || []).flatMap(s => s.DamageList || []);

  for (const skill of api.Skills || []) {
    const tree = TREE_BY_SKILL_TYPE[skill.SkillType];

    // '고유 스킬'은 공명 회로 연결점(앞의 2개)과 요리 특성 등으로 섞여 있음 — 뒤쪽은 참고용으로만 모아둠
    if (!tree) {
      if (skill.SkillType === '고유 스킬') {
        innate.push({ name: skill.SkillName, description: stripHtml(skill.SkillDescribe) });
      }
      continue;
    }

    const group = skills[tree] || (skills[tree] = { name: skill.SkillName, entries: [] });
    const attrs = (skill.SkillAttributes || []).filter(isDamageAttribute);

    attrs.forEach((attr, i) => {
      const parts = parseParts((attr.values || [])[9] || (attr.values || [])[0]);
      if (parts.length === 0) return;

      const meta = findDamageMeta(skill.DamageList, parts[0].mv)
        || findDamageMeta(allDamage, parts[0].mv);
      if (!meta) {
        warnings.push(`${label} / ${skill.SkillName} / ${attr.attributeName}: DamageList에서 판정을 못 찾음 (계수 ${parts[0].mv})`);
      } else if (!meta.type) {
        warnings.push(`${label} / ${attr.attributeName}: 모르는 판정 '${meta.rawType}'`);
      } else if (!meta.scaling) {
        warnings.push(`${label} / ${attr.attributeName}: 모르는 스케일링 '${meta.rawProperty}'`);
      }

      // 레벨별 값이 있으면 parts의 첫 칸에만 붙임(여러 파트가 같은 비율로 올라가는 구조라)
      const byLevel = levelArray(attr);
      if (byLevel && parts.length === 1) {
        parts[0].mvByLevel = byLevel;
        delete parts[0].mv;
      }

      const entry = {
        id: `${tree}-${i + 1}`,
        name: attr.attributeName,
        damageType: [(meta && meta.type) || fallbackDamageType(tree)],
        parts,
      };
      // 판정을 확정하지 못한 건 눈에 보이게 표시해서 나중에 손으로 확인할 수 있게 함
      if (!meta || !meta.type) entry._todoDamageType = true;
      const scaling = meta && meta.scaling;
      if (scaling && scaling !== 'atk') entry.scaling = scaling;

      group.entries.push(entry);
    });

    // 반주 스킬처럼 표시용 계수 행이 아예 없는 경우 — DamageList에서 직접 뽑는다.
    // 같은 스킬에 체인 강화판 계수가 섞여 있어서, 첫 항목만 기본값으로 쓰고 나머지는 확인용으로 남김.
    if (group.entries.length === 0 && (skill.DamageList || []).length) {
      const seen = [];
      skill.DamageList.forEach(d => {
        const rate = d.RateLv || [];
        const last = num(rate[rate.length - 1]);
        if (last === null || last === 0) return;
        if (seen.some(s => Math.abs(s.mv - last) < 0.011)) return;
        seen.push({ mv: last, type: resolveDamageType(d.Type), scaling: SCALING_BY_PROPERTY[d.PropertyName] || null, rate });
      });
      if (seen.length) {
        const base = seen[0];
        const byLevel = rate10(base.rate);
        const part = byLevel ? { mvByLevel: byLevel } : { mv: base.mv };
        const entry = {
          id: `${tree}-1`,
          name: skill.SkillName,
          damageType: [base.type || tree],
          parts: [part],
        };
        if (base.scaling && base.scaling !== 'atk') entry.scaling = base.scaling;
        if (seen.length > 1) {
          entry._variants = seen.slice(1).map(s => s.mv);
          warnings.push(`${label} / ${skill.SkillName}: 계수 변종 ${entry._variants.join(', ')} — 체인 강화판인지 확인 필요`);
        }
        group.entries.push(entry);
      }
    }
  }

  // 수치 연결점 8개 → 트리별 2개씩
  const treeNodes = api.SkillTree || [];
  const tier1 = treeNodes.slice(0, 4);
  const tier2 = treeNodes.slice(4, 8);
  NODE_TREE_ORDER.forEach((tree, i) => {
    if (!skills[tree]) return;
    const nodes = [];
    [tier1[i], tier2[i]].forEach(node => {
      if (!node) return;
      const effects = nodeEffects(node.PropertyNodeDescribe);
      if (!effects) {
        warnings.push(`${label}: 연결점 해석 실패 — ${stripHtml(node.PropertyNodeDescribe)}`);
        return;
      }
      nodes.push({ name: node.PropertyNodeTitle, effects });
    });
    if (nodes.length) skills[tree].nodes = nodes;
  });

  // 공명 회로의 연결점 2개는 '고유 스킬' 앞쪽 2개 — 조건부라서 버프 틀만 만들어 둠
  if (skills.circuit && innate.length >= 2) {
    skills.circuit.nodes = innate.slice(0, 2).map(n => ({
      name: n.name,
      _todo: '효과를 buff로 옮겨야 함',
      _description: n.description,
    }));
  }

  const chain = (api.ResonantChain || []).map(c => ({
    name: c.NodeName,
    description: stripHtml(c.AttributesDescription),
    buffs: [],
  }));

  return {
    element: api.ElementName || null,
    skills,
    chain,
    innate: innate.slice(2).map(n => n.name), // 요리 특성 등 — 계산 무관, 확인용
  };
}

// ── 실행 ──────────────────────────────────────────────────

function ourCharacters() {
  const src = fs.readFileSync(path.join(ROOT, 'js/data.js'), 'utf8');
  const block = src.slice(src.indexOf('const characters = ['), src.indexOf('const COMMON_BASE_STATS'));
  return [...block.matchAll(/id: '([^']+)', name: '([^']+)'/g)].map(m => ({ id: m[1], name: m[2] }));
}

function resolveEncoreId(name, table) {
  if (table.overrides[name]) return table.overrides[name];
  const want = normName(name);
  for (const [k, v] of Object.entries(table.byName)) {
    if (normName(k) === want) return v;
  }
  return null;
}

async function main() {
  const table = JSON.parse(fs.readFileSync(path.join(__dirname, 'encore-ids.json'), 'utf8'));
  let list = ourCharacters();
  if (filter) list = list.filter(c => c.name.includes(filter) || c.id.includes(filter));

  const warnings = [];
  const unmapped = [];
  const curated = [];
  let written = 0;

  for (const char of list) {
    const encoreId = resolveEncoreId(char.name, table);
    if (!encoreId) { unmapped.push(char.name); continue; }

    const res = await fetch(`${API}/${encoreId}.json`);
    if (!res.ok) { warnings.push(`${char.name}: HTTP ${res.status}`); continue; }
    const api = await res.json();

    const generated = buildCharacter(api, warnings, char.name);
    const file = path.join(ROOT, 'data/characters', char.id + '.json');
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};

    const entryCount = Object.values(generated.skills).reduce((n, g) => n + g.entries.length, 0);

    // 이미 손으로 완성한 캐릭터는 보존 — 비교 결과만 보고
    const handMade = existing.skills && !existing._generated;
    if (handMade && !FORCE) {
      const mine = [];
      Object.values(existing.skills).forEach(g => (g.entries || []).forEach(e => {
        (e.parts || []).forEach(p => mine.push(p.mv));
      }));
      const theirs = [];
      Object.values(generated.skills).forEach(g => g.entries.forEach(e => {
        (e.parts || []).forEach(p => theirs.push(p.mv !== undefined ? p.mv : (p.mvByLevel || []).slice(-1)[0]));
      }));
      const missing = mine.filter(v => !theirs.some(t => Math.abs(t - v) < 0.011));
      curated.push({ name: char.name, mine: mine.length, theirs: theirs.length, missing });
      continue;
    }

    const merged = {
      _generated: `encore.moe api (${new Date().toISOString().slice(0, 10)}) — 계수/판정/연결점/체인은 자동 생성. buffs와 rotation은 손으로 채워야 함.`,
      element: generated.element,
      baseStats: existing.baseStats || {}, // 기존 값 유지 (손으로 확인해 둔 수치)
      skills: generated.skills,
      buffs: existing.buffs || [],
      rotation: existing.rotation || null,
      chain: existing.chain && existing.chain.some(c => (c.buffs || []).length) ? existing.chain : generated.chain,
    };
    if (generated.innate.length) merged._innateSkills = generated.innate;

    if (WRITE) fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
    written++;
    console.log(`${WRITE ? '씀' : '생성 가능'}  ${char.name.padEnd(14)} 스킬 ${String(entryCount).padStart(3)}개  체인 ${generated.chain.length}개  ${generated.element || '속성?'}`);
  }

  console.log('\n──────────────────────────────');
  console.log(`대상 ${list.length}명 / ${WRITE ? '기록' : '생성 가능'} ${written}명`);
  if (curated.length) {
    console.log('\n[손으로 작성된 캐릭터 — 보존하고 계수만 대조]');
    curated.forEach(c => console.log(`  ${c.name}: 기존 ${c.mine}개 중 API에서 못 찾은 계수 ${c.missing.length}개` +
      (c.missing.length ? ' → ' + c.missing.join(', ') : ' (전부 일치)')));
  }
  if (unmapped.length) console.log('\n[encore id 미매핑]', unmapped.join(', '));
  if (warnings.length) {
    console.log(`\n[경고 ${warnings.length}건]`);
    warnings.slice(0, 40).forEach(w => console.log('  ' + w));
    if (warnings.length > 40) console.log(`  ... 그 외 ${warnings.length - 40}건`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
