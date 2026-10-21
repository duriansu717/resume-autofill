/**
 * 匹配引擎：给「控件 × 简历字段」的所有组合打分，再做全局分配。
 *
 * 两个关键设计：
 *
 * 1. 打分用「主导证据 + 佐证」而不是简单求和。
 *    一个权威信号（<label for> 写着「手机号」）不应该被一堆弱信号
 *    （name 里含 phone、容器文本含 电话…）累加超过。所以：
 *      raw = 最大值 + 0.35 × 其余之和
 *
 * 2. 分配是全局的，不是逐个字段独立决策。
 *    所有候选对按分数降序贪心占用，保证「一个控件只填一个字段、
 *    一个字段（在同一条经历里）只占一个控件」。
 */
(function (root) {
  'use strict';

  const RA = root.RA;
  const N = RA.normalize;
  const F = RA.fields;

  // ─────────────────────────── 信号权重 ───────────────────────────

  const W = {
    autocomplete: 100,
    labelFor: 90,
    labelWrap: 85,
    labelLegend: 88,
    labelAriaLabelledby: 80,
    labelAria: 78,
    labelFramework: 76,
    labelFrameworkWeak: 62,
    labelContainer: 60,
    labelCell: 64,
    labelGeometric: 56,
    placeholderDescriptive: 70,
    placeholderPlain: 45,
    placeholderValueLike: 22,
    name: 55,
    id: 50,
    title: 45,
    nearby: 40,
    className: 30,
    optionTexts: 34,
    enumHint: 85,
  };

  const LABEL_SOURCE_WEIGHT = {
    for: W.labelFor,
    wrap: W.labelWrap,
    legend: W.labelLegend,
    'aria-labelledby': W.labelAriaLabelledby,
    'aria-label': W.labelAria,
    framework: W.labelFramework,
    'framework-weak': W.labelFrameworkWeak,
    container: W.labelContainer,
    cell: W.labelCell,
    thead: W.labelCell,
    geometric: W.labelGeometric,
    none: 0,
  };

  /** autocomplete 标准 token → 字段 key */
  const AC_MAP = (() => {
    const m = Object.create(null);
    for (const def of F.DEFS) {
      for (const tok of def.ac || []) {
        if (!m[tok]) m[tok] = def.key;
      }
    }
    return m;
  })();

  /**
   * 枚举提示：某些 select/radio 组的选项集合本身就是强指纹。
   * 一个下拉里只有「男 / 女」两个选项，那它一定是性别，不需要看标签。
   */
  const ENUM_HINTS = {
    'basic.gender': ['男', '女', '男性', '女性', 'male', 'female'],
    'basic.maritalStatus': ['未婚', '已婚', '离异', '丧偶'],
    'basic.politicalStatus': ['中共党员', '中共预备党员', '预备党员', '共青团员', '群众', '民主党派', '党员'],
    'educations.degree': ['小学', '初中', '高中', '中专', '大专', '专科', '本科', '硕士', '博士', '研究生', '学士'],
    'educations.isFullTime': ['全日制', '非全日制', '统招', '自考', '成人教育', '网络教育', '函授', '业余', '脱产'],
    'jobIntention.jobType': ['全职', '兼职', '实习', '临时'],
  };

  // ─────────────────────────── 信号采集 ───────────────────────────

  /** 把一个描述符的所有信号摊平成 [{source, weight, text}] */
  function signalSources(d) {
    const s = d.signals;
    const out = [];

    const push = (source, weight, text) => {
      if (!text) return;
      const t = String(text).trim();
      if (!t) return;
      out.push({ source, weight, text: t });
    };

    // autocomplete 单独处理（它是 token 不是自然语言）
    if (s.autocomplete) out.push({ source: 'autocomplete', weight: W.autocomplete, text: s.autocomplete, isToken: true });

    push('label', LABEL_SOURCE_WEIGHT[s.labelSource] || W.labelContainer, s.labelText);
    push('aria', W.labelAria, s.ariaLabel);
    push('title', W.title, s.title);

    if (s.placeholder) {
      if (s.placeholderIsValueLike) push('placeholder', W.placeholderValueLike, s.placeholder);
      else if (s.placeholderIsDescriptive) push('placeholder', W.placeholderDescriptive, s.placeholder);
      else push('placeholder', W.placeholderPlain, s.placeholder);
    }

    push('name', W.name, s.name);
    push('id', W.id, s.id);
    push('class', W.className, s.className);

    for (const t of s.nearbyText || []) push('nearby', W.nearby, t);

    if (s.optionTexts && s.optionTexts.length) {
      push('options', W.optionTexts, s.optionTexts.join(' '));
    }

    return out;
  }

  /** 计算某个信号对某个字段的贡献度 */
  function contribution(src, def) {
    if (src.isToken) {
      // autocomplete 是精确 token 匹配，不做模糊
      const tok = src.text.toLowerCase().replace(/^section-/, '');
      const target = AC_MAP[tok];
      return target === def.key ? src.weight : 0;
    }

    const norm = N.text(src.text);
    const spaced = N.spaced(src.text);
    if (!norm) return 0;

    let strength = 0;
    const strong = N.bestMatch(def.aliases, norm, spaced);
    if (strong) {
      strength = strong.strength;
    } else {
      // 弱别名（跨区块共享的「开始时间」之类）单独命中时可信度打折，
      // 真正定位靠的是区块信息
      const gen = N.bestMatch(def.generic, norm, spaced);
      if (gen) strength = gen.strength * 0.72;
    }
    if (strength <= 0) return 0;

    // 反向别名软性扣分，而不是硬性排除——
    // 「用户名」应该把「姓名」压低，但不该让这个控件彻底失去匹配机会
    let negStrength = 0;
    if (def.negative && def.negative.length) {
      const neg = N.bestMatch(def.negative, norm, spaced);
      if (neg) negStrength = neg.strength;
    }

    return src.weight * strength * (1 - 0.9 * negStrength);
  }

  /** 枚举指纹：选项集合和已知枚举高度重合时给一个强加分 */
  function enumHintScore(d, key) {
    const hints = ENUM_HINTS[key];
    if (!hints) return 0;
    const opts = d.signals.optionTexts || [];
    if (opts.length < 2 || opts.length > 15) return 0;

    const normOpts = opts.map((o) => N.text(o));
    let hit = 0;
    for (const o of normOpts) {
      if (!o) continue;
      if (hints.some((h) => {
        const hn = N.text(h);
        return o === hn || o.includes(hn) || hn.includes(o);
      })) hit++;
    }
    const ratio = hit / normOpts.length;
    return ratio >= 0.6 ? W.enumHint * ratio : 0;
  }

  // ─────────────────────────── 类型与长度先验 ───────────────────────────

  function typeGate(d, def) {
    const t = d.signals.inputType;
    const key = def.key;

    // type=email 只可能是各类邮箱，这是硬约束。
    // 注意要放行所有邮箱类字段（学校邮箱 / 备用邮箱），不能只认 basic.email。
    if (t === 'email') return /(email|mail)/i.test(key) ? 1 : 0;
    if (t === 'url') return /(website|link)$/.test(key) ? 1 : 0.2;

    if (t === 'tel') {
      // 手机 / 备用手机 / 家庭电话 / 紧急联系人电话都算，其余一律压低
      return /(phone|tel)/i.test(key) ? 1 : 0.25;
    }

    if (t === 'date') {
      const isDate = /(birthday|date|startdate|enddate)/i.test(key);
      return isDate ? 1 : 0.15;
    }

    if (t === 'number') {
      if (/^(basic\.(age|height|weight|postalCode|qq)|.*\.(gpa|salary))$/.test(key)) return 1.15;
      // 数字框里填中文姓名是错的
      if (key === 'basic.name' || key === 'basic.email') return 0.1;
    }

    // 多行文本框只可能是描述类的
    if (d.kind === 'textarea') {
      const isLong = /(description|selfEvaluation|skills|evaluation)/i.test(key);
      return isLong ? 1.2 : 0.25;
    }

    // 单行框承担不了大段文字
    if (d.kind === 'text' && /(description|selfEvaluation)$/i.test(key)) return 0.5;

    return 1;
  }

  function lengthBoost(d, def) {
    const ml = d.signals.maxLength;
    if (!ml || !def.maxLength) return 1;
    const [lo, hi] = def.maxLength;
    if (ml >= lo && ml <= hi) return 1.25;
    // maxlength 明显对不上，比如 4 个字符的框不可能是详细地址
    if (ml < lo) return 0.4;
    return 1;
  }

  function sectionGate(d, def) {
    const sectionKey = d.section && d.section.key;
    if (!sectionKey || !d.section.confidence) return 1;

    if (def.section === sectionKey) return 1.12;

    // 属于经历类区块的字段，跑到别的区块里去了 —— 重罚但不清零。
    // 「开始时间」在教育经历下就是入学时间，不该被工作经历抢走。
    if (F.REPEATING_SECTIONS.includes(def.section) && F.REPEATING_SECTIONS.includes(sectionKey)) {
      return 0.12;
    }
    // 基本信息字段出现在经历区块里，多半也是错的
    if (def.section === 'basic' && F.REPEATING_SECTIONS.includes(sectionKey)) {
      const universal = ['basic.name', 'basic.phone', 'basic.email', 'basic.gender', 'basic.birthday'];
      return universal.includes(def.key) ? 0.5 : 0.2;
    }
    return 1;
  }

  /** 全部可匹配的字段 key。只算一次，别在每次匹配时重新 map。 */
  const ALL_KEYS = F.DEFS.map((x) => x.key);

  // ─────────────────────────── 单个字段打分 ───────────────────────────

  function scoreField(d, keys) {
    const sources = signalSources(d);
    const results = [];

    for (const key of keys) {
      const def = F.BY_KEY[key];
      if (!def) continue;

      const contribs = [];
      for (const src of sources) {
        const c = contribution(src, def);
        if (c > 0) contribs.push({ ...src, contrib: c });
      }

      const hint = enumHintScore(d, key);
      if (hint > 0) contribs.push({ source: 'enum-hint', weight: W.enumHint, contrib: hint });

      if (!contribs.length) continue;

      // 主导证据 + 佐证
      contribs.sort((a, b) => b.contrib - a.contrib);
      const top = contribs[0].contrib;
      const rest = contribs.slice(1).reduce((s, c) => s + c.contrib, 0);
      let raw = top + 0.35 * rest;

      raw *= typeGate(d, def);
      raw *= lengthBoost(d, def);
      raw *= sectionGate(d, def);

      let score = Math.max(0, Math.min(1, raw / 100));

      // 日期组必须匹配日期类的 key
      if (d.kind === 'date-cluster' && !/(birthday|date|Date)/.test(key)) score *= 0.15;

      if (score <= 0.02) continue;
      results.push({
        key,
        score,
        evidence: contribs.slice(0, 4).map((c) => ({
          source: c.source, weight: c.weight, contrib: Math.round(c.contrib),
        })),
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 5);
  }

  // ─────────────────────────── 全局分配 ───────────────────────────

  /** 一个字段在某个条目下的「槽位」。重复区块里同一字段可以出现在多条经历中。 */
  function slotOf(d, key) {
    const def = F.BY_KEY[key];
    if (!def) return key;
    if (F.REPEATING_SECTIONS.includes(def.section)) {
      const idx = (d.section && d.section.entryIndex) || 0;
      return `${key}#${idx}`;
    }
    return key;
  }

  /**
   * 主入口。
   * @returns {Array<{descriptor, key, score, evidence, tier}>}
   */
  function match(descriptors, opts = {}) {
    const keys = ALL_KEYS;
    const pairs = [];

    for (const d of descriptors) {
      if (d.consumed) continue;
      for (const cand of scoreField(d, keys)) {
        pairs.push({ d, key: cand.key, score: cand.score, evidence: cand.evidence });
      }
    }

    // 全局贪心：分数高的先占坑
    pairs.sort((a, b) => b.score - a.score);

    const usedEl = new Set();
    const usedSlot = new Set();
    const out = [];

    for (const p of pairs) {
      if (usedEl.has(p.d.el)) continue;
      const slot = slotOf(p.d, p.key);
      if (usedSlot.has(slot)) continue;
      usedEl.add(p.d.el);
      usedSlot.add(slot);
      out.push(p);
    }

    // 按文档顺序输出，填充时视觉上更自然
    out.sort((a, b) => a.d.domIndex - b.d.domIndex);

    const HIGH = opts.highThreshold ?? 0.72;
    const FILL = opts.fillThreshold ?? 0.5;

    for (const m of out) {
      m.tier = m.score >= HIGH ? 'high' : m.score >= FILL ? 'low' : 'skip';
    }

    return out;
  }

  RA.score = {
    match,
    scoreField,
    signalSources,
    contribution,
    slotOf,
    AC_MAP,
    ENUM_HINTS,
    WEIGHTS: W,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
