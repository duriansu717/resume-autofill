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

  // ─────────────────────────── 上下文模块推断 ───────────────────────────

  /** 日期类字段，用来排除「自己给自己投票」 */
  const DATE_KEY_RE = /(birthday|startDate|endDate|date|graduateYear|availableFrom)$/;

  /**
   * 一个控件旁边的字段，能不能明确说出「我们在哪个模块」？
   * 只看强别名（学校名称 / 公司名称 / 项目名称…），不看「开始时间」这类跨模块通用的词。
   */
  function sectionVoteOf(d) {
    const s = d.signals || {};
    const text = [s.labelText, s.placeholder, s.name, s.id, s.ariaLabel].filter(Boolean).join(' ');
    const norm = N.text(text);
    if (!norm) return null;
    const spaced = N.spaced(text);

    let best = null;
    for (const def of F.DEFS) {
      if (!F.REPEATING_SECTIONS.includes(def.section)) continue;
      if (DATE_KEY_RE.test(def.key)) continue;

      const m = N.bestMatch(def.aliases, norm, spaced);
      if (!m) continue;

      // 单元格 / 容器文本比 aria-label 弱一点，但仍然是有效证据
      const source = s.labelSource || '';
      const weight = source === 'cell' || source === 'container' ? 0.85 : 1;
      const score = m.strength * weight;

      if (!best || score > best.score) best = { section: def.section, score };
    }

    return best && best.score >= 0.75 ? best : null;
  }

  /**
   * 给「区块不明 / 低置信」的控件补一个上下文模块。
   *
   * 场景：页面上有两行经历，只写「开始时间 / 结束时间」，没有区块标题，
   * 或者标题识别失败。这时日期字段自己分不清教育还是工作，但它旁边的
   * 「学校名称」「公司名称」是有明确归属的——用它们投票。
   *
   * 顺序只在同一模块、同一组完全同名的「起止时间」之间作为最后兜底，
   * 不再承担「跨模块区分」的职责。
   */
  function annotateContext(descriptors) {
    if (!descriptors || descriptors.length < 2) return;

    for (const d of descriptors) delete d.contextSection;

    const ambiguous = descriptors.filter((d) =>
      !d.section || !d.section.key || (d.section.confidence || 0) < 0.6);

    for (const d of ambiguous) {
      if (!d.el || !d.el.parentElement) continue;

      // 从最近到最远找一个「至少包含另一个字段」的祖先。
      // 先找到的是行 / 表单项组，能避免跨模块串味。
      const body = typeof document !== 'undefined' ? document.body : null;
      let node = d.el.parentElement;
      let members = null;
      for (let depth = 0; depth < 8 && node && node !== body; depth++, node = node.parentElement) {
        const list = descriptors.filter((x) => x !== d && !x.consumed && node.contains(x.el));
        if (!list.length) continue;
        if (list.length > 12) break; // 已经跨到很大的容器了，不猜
        members = list;
        break;
      }
      if (!members) continue;

      const votes = {};
      for (const s of members) {
        const v = sectionVoteOf(s);
        if (v) votes[v.section] = (votes[v.section] || 0) + v.score;
      }

      const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
      if (!ranked.length) continue;

      const [winner, score] = ranked[0];
      const second = ranked[1] ? ranked[1][1] : 0;
      // 票数太少或两个模块咬得太紧，都不下结论
      if (score < 0.75) continue;
      if (second && score < second * 1.5) continue;

      d.contextSection = winner;
    }
  }

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

      // 上下文模块：只在「自己的区块不明」时介入。
      // 「开始时间」旁边就是「学校名称」→ 它是教育经历的开始时间，
      // 跟它在文档里排第几无关。
      const ctx = d.contextSection;
      if (ctx && (!d.section || !d.section.key || (d.section.confidence || 0) < 0.6)) {
        if (F.REPEATING_SECTIONS.includes(def.section)) {
          raw *= def.section === ctx ? 1.2 : 0.35;
        }
      }

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
    // 先给区块不明的字段补上下文（靠旁边的学校 / 公司 / 项目字段投票）
    annotateContext(descriptors);

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
    annotateContext,
    sectionVoteOf,
    signalSources,
    contribution,
    slotOf,
    AC_MAP,
    ENUM_HINTS,
    WEIGHTS: W,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
