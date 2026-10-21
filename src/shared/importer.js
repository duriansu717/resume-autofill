/**
 * 导入助手：把「任意来源的 JSON」整理成我们的简历结构。
 *
 * 三件事，全部是纯函数，不碰 DOM：
 *   1. extractJson      —— 从 AI 的输出里把 JSON 抠出来
 *   2. normalizeProfile —— 归一化（类型 / 日期 / 结构 / 中文 key）
 *   3. buildPrompt      —— 按当前模板生成给 AI 的提示词
 *
 * 为什么不自己解析 PDF / Word：理解任意排版是无底洞，交给用户自己的 AI 更靠谱，
 * 扩展只负责「给出契约」和「验收结果」。
 */
(function (root) {
  'use strict';

  const RA = root.RA;
  const N = RA.normalize;

  // ─────────────────────── 1. 容错解析 ───────────────────────

  function stripBom(s) {
    return s.replace(/^﻿/, '');
  }

  /** 去掉 ```json 代码围栏 */
  function stripFences(s) {
    return s.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  }

  /**
   * 从一段文本里取出第一个完整的 JSON 对象。
   *
   * 不能直接 JSON.parse：AI 的输出经常是「好的，这是结果：```json {...}```，
   * 如有需要我可以…」。所以先剥围栏，再从第一个 { 开始做括号配对，
   * 配对时要跳过字符串里的括号。
   */
  function extractJson(text) {
    if (typeof text !== 'string') return { ok: false, error: '没有内容' };

    let s = stripBom(text).trim();
    if (!s) return { ok: false, error: '没有内容' };

    s = stripFences(s);

    const start = s.indexOf('{');
    if (start < 0) return { ok: false, error: '没找到 JSON 对象（缺少 {）' };

    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;

    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }

    if (end < 0) return { ok: false, error: 'JSON 没有闭合（缺少 }）' };

    const raw = s.slice(start, end);
    const attempts = [raw, repair(raw)];
    for (let i = 0; i < attempts.length; i++) {
      try {
        return { ok: true, value: JSON.parse(attempts[i]), repaired: i > 0 };
      } catch (e) { /* 试下一个 */ }
    }
    return { ok: false, error: '不是合法的 JSON，检查引号、逗号和括号' };
  }

  /** 常见的小毛病：中文引号、尾逗号、没加引号的键 */
  function repair(s) {
    return s
      .replace(/[“”]/g, '"')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  }

  // ─────────────────────── 2. 归一化 ───────────────────────

  const OBJECT_TOP = ['basic', 'jobIntention', 'emergency', 'custom'];

  const ARRAY_TOP = [
    'educations', 'works', 'internships', 'projects',
    'campusExperiences', 'trainings', 'certificates', 'languages', 'awards',
    'competitions', 'studentCadreExperiences', 'itSkills',
  ];

  const KNOWN_TOP = OBJECT_TOP.concat(ARRAY_TOP);

  const DATE_FIELDS = new Set(['birthday', 'startDate', 'endDate', 'date']);

  const PRESENT_RE = /^(至今|现在|目前|今|present|now|current)$/i;

  const EMPTY_RE = /^(未知|不详|无|没有|暂无|none|null|undefined|n\/a|na|n\.a\.?|-|—|\/)$/i;

  function pad2(n) {
    const s = String(n);
    return s.length < 2 ? '0' + s : s;
  }

  /** 把各种写法归一成 2021-07 / 2021-07-15 */
  function normDate(raw) {
    const t = String(raw).trim();
    if (!t) return '';

    // 2021年7月 / 2021-07-15 / 2021/7 / 2021.7.5 / 2021年7月15日
    let m = /^(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]?\s*(\d{1,2})?\s*[日号]?$/.exec(t);
    if (m) {
      const y = m[1];
      const mo = pad2(m[2]);
      const d = m[3] ? pad2(m[3]) : '';
      return d ? `${y}-${mo}-${d}` : `${y}-${mo}`;
    }

    m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;

    m = /^(\d{4})(\d{2})$/.exec(t);
    if (m) return `${m[1]}-${m[2]}`;

    return t;
  }

  function nameOf(key) {
    return key.slice(key.indexOf('.') + 1);
  }

  function labelOf(key) {
    const def = RA.fields.BY_KEY[key];
    return def ? def.label : nameOf(key);
  }

  /** 把单值整理成字符串：数字、布尔、数组、空值都在这里收口 */
  function coerceValue(key, raw, fixes, where) {
    if (raw == null) return '';

    let v;

    if (typeof raw === 'number') {
      v = String(raw);
      if (!Number.isFinite(raw)) return '';
    } else if (typeof raw === 'boolean') {
      return raw ? '是' : '否';
    } else if (Array.isArray(raw)) {
      v = raw
        .filter((x) => x != null && typeof x !== 'object')
        .map((x) => String(x).trim())
        .filter(Boolean)
        .join('、');
      if (v) fixes.push(`${where}${labelOf(key)}：数组已合并成一段文本`);
    } else if (typeof raw === 'object') {
      return '';
    } else {
      v = String(raw);
    }

    // 不间断空格、全角空格在简历文本里很常见，统一成普通空格
    v = v.replace(/[\u00A0\u3000]/g, ' ').trim();
    if (EMPTY_RE.test(v)) return '';

    const name = nameOf(key);
    if (DATE_FIELDS.has(name)) {
      if (PRESENT_RE.test(v)) {
        fixes.push(`${where}${labelOf(key)}：把「${v}」留空（用「是否在职」这类字段表达）`);
        return '';
      }
      const d = normDate(v);
      if (d !== v) {
        fixes.push(`${where}${labelOf(key)}：${v} → ${d}`);
        return d;
      }
    }

    return v;
  }

  // 中文标签 / 别名 → 字段 key。用到时才建，避免不必要的启动开销
  let labelMap = null;
  let aliasMap = null;

  function buildMaps() {
    if (labelMap) return;
    labelMap = Object.create(null);
    aliasMap = Object.create(null);

    for (const def of RA.fields.DEFS) {
      const lab = N.text(def.label);
      if (lab && !labelMap[lab]) labelMap[lab] = def.key;

      for (const a of def.aliases || []) {
        const k = N.text(a);
        // 别名冲突时保留先出现的：DEFS 里越靠前越专有
        if (k && !aliasMap[k]) aliasMap[k] = def.key;
      }
    }
  }

  /** 扁平结构里的 key（「姓名」「姓名：」「教育经历-学校」）→ 字段 key */
  function mapFlatKey(rawKey) {
    const raw = String(rawKey).trim();
    if (RA.fields.BY_KEY[raw]) return raw;

    buildMaps();

    const candidates = [raw];
    const tail = raw.split(/[.\-/_：:]/).pop();
    if (tail && tail !== raw) candidates.push(tail);

    for (const c of candidates) {
      const k = N.text(c);
      if (!k) continue;
      if (labelMap[k]) return labelMap[k];
      if (aliasMap[k]) return aliasMap[k];
    }
    return null;
  }

  /**
   * 把任意 JSON 整理成 { basic: {...}, educations: [...], custom: {...} }。
   *
   * 返回里带三类报告，供导入预览展示：
   *   fixes   —— 修正了什么（日期格式、单对象包数组、数组合并…）
   *   unknown —— 不认识、被丢掉的键
   *   mapped  —— 扁平结构里成功映射的键数
   */
  function normalizeProfile(input) {
    const fixes = [];
    const unknown = [];
    let mapped = 0;

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { profile: {}, fixes, unknown, mapped, error: '顶层必须是一个 JSON 对象' };
    }

    const profile = {};
    const structured = Object.keys(input).some((k) => KNOWN_TOP.includes(k));

    if (structured) {
      for (const [top, val] of Object.entries(input)) {
        if (top.startsWith('_')) continue;

        if (top === 'custom') {
          if (!val || typeof val !== 'object' || Array.isArray(val)) {
            unknown.push('custom（应为对象）');
            continue;
          }
          const obj = {};
          for (const [k, v] of Object.entries(val)) {
            const s = v == null ? '' : String(v).trim();
            if (s) obj[k] = s;
          }
          if (Object.keys(obj).length) profile.custom = obj;
          continue;
        }

        if (OBJECT_TOP.includes(top)) {
          if (!val || typeof val !== 'object' || Array.isArray(val)) {
            unknown.push(`${top}（应为对象）`);
            continue;
          }
          const obj = {};
          for (const [k, v] of Object.entries(val)) {
            const key = k.includes('.') ? k : `${top}.${k}`;
            if (!RA.fields.BY_KEY[key]) { unknown.push(key); continue; }
            const name = nameOf(key);
            const s = coerceValue(key, v, fixes, `${top}.`);
            if (s) obj[name] = s;
          }
          if (Object.keys(obj).length) profile[top] = obj;
          continue;
        }

        if (ARRAY_TOP.includes(top)) {
          let arr = val;
          if (!Array.isArray(arr)) {
            if (arr && typeof arr === 'object') {
              arr = [arr];
              fixes.push(`${top}：单个对象已包成数组`);
            } else {
              unknown.push(`${top}（应为数组）`);
              continue;
            }
          }

          const out = [];
          arr.forEach((item, i) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return;
            const obj = {};
            for (const [k, v] of Object.entries(item)) {
              const key = k.includes('.') ? k : `${top}.${k}`;
              if (!RA.fields.BY_KEY[key]) { unknown.push(`${top}[${i}].${k}`); continue; }
              const name = nameOf(key);
              const s = coerceValue(key, v, fixes, `${top}[${i}].`);
              if (s) obj[name] = s;
            }
            if (Object.keys(obj).length) out.push(obj);
          });
          if (out.length) profile[top] = out;
          continue;
        }

        unknown.push(top);
      }
    } else {
      // 扁平结构：{ "姓名": "张三", "手机号": "138..." }
      for (const [k, v] of Object.entries(input)) {
        if (k.startsWith('_')) continue;
        const key = mapFlatKey(k);
        if (!key) { unknown.push(k); continue; }

        const top = key.slice(0, key.indexOf('.'));
        const name = nameOf(key);
        const s = coerceValue(key, v, fixes, '');
        if (!s) continue;

        if (ARRAY_TOP.includes(top)) {
          if (!profile[top]) profile[top] = [{}];
          profile[top][0][name] = s;
        } else {
          if (!profile[top]) profile[top] = {};
          profile[top][name] = s;
        }
        mapped++;
      }
    }

    return { profile, fixes, unknown, mapped };
  }

  // ─────────────────────── 3. 提示词 ───────────────────────

  function defaultGroups() {
    return RA.fields.SECTION_ORDER.map((sectionKey) => ({
      sectionKey,
      title: RA.fields.SECTION_LABEL[sectionKey] || sectionKey,
      fields: (RA.fields.KEYS_BY_SECTION[sectionKey] || []).map((key) => ({ key })),
    }));
  }

  /**
   * 按模板生成提示词。从字段定义现算，模板加减字段后提示词自动跟着变。
   */
  function buildPrompt(template) {
    const groups = (template && Array.isArray(template.groups) && template.groups.length)
      ? template.groups
      : defaultGroups();

    const skeleton = {};
    const lines = [];
    const seen = new Set();

    for (const g of groups) {
      if (!g || !Array.isArray(g.fields)) continue;

      if (!g.sectionKey) {
        // 自定义分组
        for (const f of g.fields) {
          if (!f || !f.key || !String(f.key).startsWith('custom.')) continue;
          if (seen.has(f.key)) continue;
          seen.add(f.key);
          const id = String(f.key).slice('custom.'.length);
          if (!skeleton.custom) skeleton.custom = {};
          skeleton.custom[id] = '';
          lines.push(`${id} = ${f.label || id}`);
        }
        continue;
      }

      const arrName = RA.fields.ARRAY_NAME_BY_SECTION[g.sectionKey];
      const top = arrName || g.sectionKey;

      for (const f of g.fields) {
        if (!f || !f.key) continue;
        if (seen.has(f.key)) continue;
        seen.add(f.key);

        const def = RA.fields.BY_KEY[f.key];
        if (!def) continue;

        const name = nameOf(f.key);
        if (arrName) {
          if (!skeleton[top]) skeleton[top] = [{}];
          skeleton[top][0][name] = '';
        } else {
          if (!skeleton[top]) skeleton[top] = {};
          skeleton[top][name] = '';
        }
        lines.push(`${name} = ${def.label}`);
      }
    }

    const schema = JSON.stringify(skeleton, null, 2);

    return [
      '你是数据整理助手。请把下面的简历内容整理成指定格式的 JSON。',
      '',
      '规则：',
      '1. 只输出一个 JSON 对象，不要任何解释文字，不要用 ``` 代码块包裹。',
      '2. 严格使用下面给出的 key，不要增删字段，不要改写字段名。',
      '3. 简历里没有提到的信息一律填空字符串 ""，不要编造或推测。',
      '4. 日期统一写成 YYYY-MM 或 YYYY-MM-DD，例如 2021-07、1998-07-15。',
      '5. 经历类字段是数组：一段经历一个对象，按时间从近到远排列。',
      '6. 所有值都写成字符串，不要用数字、布尔值或 null。',
      '7. 如果内容是图片或 PDF，请先识别文字再填写。',
      '',
      '输出结构：',
      schema,
      '',
      '字段中文名对照：',
      lines.join('\n'),
      '',
      '我的简历：',
      '（在这里粘贴简历内容，或上传文件）',
    ].join('\n');
  }

  // ─────────────────────── 小工具 ───────────────────────

  /** 统计一份 profile 里有多少个非空值，导入预览用 */
  function countValues(p) {
    let n = 0;
    const walk = (v) => {
      if (typeof v === 'string') {
        if (v.trim()) n++;
        return;
      }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') {
        for (const x of Object.values(v)) walk(x);
      }
    };
    walk(p);
    return n;
  }

  RA.importer = {
    extractJson,
    repair,
    normalizeProfile,
    buildPrompt,
    countValues,
    OBJECT_TOP,
    ARRAY_TOP,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
