/**
 * 区块识别 + 重复块拆分 + 拆分日期检测。
 *
 * 页面上的字段不能孤立地看。「开始时间」这四个字本身没有意义——
 * 它在「教育经历」下就是入学时间，在「工作经历」下就是入职时间。
 * 这个文件负责给每个字段打上「我属于哪个区块、是该区块的第几条」。
 */
(function (root) {
  'use strict';

  const RA = root.RA;
  const N = RA.normalize;
  const F = RA.fields;
  const S = RA.scan;

  const HEADING_SEL = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend', 'summary',
    '[role="heading"]',
    '[class*="title"]', '[class*="heading"]', '[class*="header"]',
    '[class*="panel-title"]', '[class*="card-title"]', '[class*="group-name"]',
    '[class*="section-name"]', '[class*="block-title"]',
  ].join(',');

  function isHeadingTag(node) {
    return /^H[1-6]$/.test(node.tagName) || node.tagName === 'LEGEND' ||
      node.getAttribute('role') === 'heading';
  }

  function isHeadingLike(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.hasAttribute('data-ra-ignore')) return false;
    if (isHeadingTag(node)) return true;
    const cls = (node.getAttribute('class') || '').toLowerCase();
    return /(title|heading|header|legend|group-name|section-name|block-title)/.test(cls);
  }

  /** 在全部字段的强别名里，找出与这段文字最匹配的那个 */
  function strongestFieldAlias(text) {
    const norm = N.text(text);
    const spaced = N.spaced(text);
    if (!norm) return null;

    let best = null;
    for (const def of F.DEFS) {
      // 只看强别名——弱别名太泛（「开始时间」到处都有），会把真标题误杀
      const hit = N.bestMatch(def.aliases, norm, spaced);
      if (!hit || hit.strength < 0.8) continue;
      const len = N.text(hit.alias).length;
      if (!best || len > best.len) best = { len, key: def.key, alias: hit.alias };
    }
    return best;
  }

  /**
   * 这段文字是不是更像「某个字段的标签」而不是区块标题？
   *
   * 判据是长度对比，而不是「命中就否决」。基本信息区块里每个字段标签都是短文本，
   * 「姓名」当然不能当区块标题；但「语言能力」既是区块名、又含有字段别名「语言」，
   * 这时该听区块的——因为区块别名更长、更具体。
   */
  function looksLikeFieldLabel(text, sectionAliasLen = 0) {
    const fieldHit = strongestFieldAlias(text);
    return !!fieldHit && fieldHit.len > sectionAliasLen;
  }

  /**
   * 把标题文字归类到区块。
   */
  function classifySectionKind(text) {
    const norm = N.text(text);
    if (!norm || norm.length > 20) return null;

    let best = null;
    const scan = (table, isEn) => {
      for (const key of Object.keys(table)) {
        for (const alias of table[key]) {
          const an = isEn ? N.spaced(alias) : N.text(alias);
          if (!an) continue;
          const hay = isEn ? N.spaced(text) : norm;
          if (!hay.includes(an)) continue;
          // 别名越长越可信：「教育经历」强于「教育」
          const score = an.length + (isEn ? 2 : 0);
          if (!best || score > best.score) best = { key, score, alias, len: an.length };
        }
      }
    };
    scan(F.SECTION_ALIASES, false);
    scan(F.SECTION_ALIASES_EN, true);

    if (!best) return null;

    // 只有当文本同时强烈匹配某个字段、且那个字段别名比区块别名更具体时，
    // 才判定它是字段标签而不是区块标题
    if (looksLikeFieldLabel(text, best.len)) return null;

    return best.key;
  }

  /** 从某个元素往上找区块标题 */
  function findSectionTitle(node, maxDepth = 9) {
    let cur = node;
    for (let d = 0; d < maxDepth && cur && cur !== document.body; d++) {
      // 自己就是标题（少见但存在，比如 fieldset>legend）
      if (d > 0 && isHeadingLike(cur)) {
        const t = S.ownText(cur);
        if (t && t.length <= 30) {
          const kind = classifySectionKind(t);
          if (kind) return { el: cur, text: t, kind };
        }
      }

      // 看前面的兄弟节点，从近到远
      let prev = cur.previousElementSibling;
      let hops = 0;
      while (prev && hops < 6) {
        if (isHeadingLike(prev)) {
          const t = S.ownText(prev);
          if (t && t.length <= 30) {
            const kind = classifySectionKind(t);
            if (kind) return { el: prev, text: t, kind };
          }
        }
        prev = prev.previousElementSibling;
        hops++;
      }

      cur = cur.parentElement;
    }
    return null;
  }

  /**
   * 判断某个元素是不是「重复条目」之一。
   * 依据：它的兄弟里有 ≥2 个结构相同的元素。
   */
  function signatureOf(node) {
    if (!node || node.nodeType !== 1) return '';
    const cls = S.stripDynamicTokens(node.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean)
      .sort()
      .join('.');
    const controls = node.querySelectorAll('input:not([type=hidden]),select,textarea').length;
    return `${node.tagName}|${controls}|${cls}`;
  }

  function findEntryContainer(el, sectionRoot) {
    let node = el.parentElement;
    for (let d = 0; d < 6 && node && node !== document.body; d++) {
      if (node === sectionRoot) break;
      const parent = node.parentElement;
      if (parent) {
        const sig = signatureOf(node);
        if (sig) {
          const sibs = Array.from(parent.children).filter((c) => signatureOf(c) === sig);
          if (sibs.length >= 2) {
            return { entryEl: node, index: sibs.indexOf(node), count: sibs.length };
          }
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  /** 找区块内的「添加」按钮 */
  const ADD_RE = /^(添加|新增|增加|再加|新建|\+|add|add more|add another|insert)/i;

  function findAddButton(scope) {
    if (!scope) return null;
    const cands = scope.querySelectorAll('button, a, [role="button"], [class*="add"], [class*="btn"]');
    for (const c of cands) {
      if (c.hasAttribute('data-ra-ignore')) continue;
      const t = S.ownText(c).trim();
      if (!t || t.length > 12) continue;
      if (ADD_RE.test(t)) return c;
    }
    return null;
  }

  // ─────────────────────── 拆分日期（年/月/日 三个控件） ───────────────────────

  const UNIT_PATTERNS = [
    { unit: 'Y', re: /(^|[^a-z])(年|年份|yyyy|yy|year)([^a-z]|$)/i, len: 4 },
    { unit: 'M', re: /(^|[^a-z])(月|月份|mm|month)([^a-z]|$)/i, len: 2 },
    { unit: 'D', re: /(^|[^a-z])(日|号|天|dd|day)([^a-z]|$)/i, len: 2 },
  ];

  /** 从单个控件推断它是年 / 月 / 日中的哪一个 */
  function inferUnit(el, signals) {
    const parts = [
      signals.labelText, signals.placeholder, signals.name, signals.id,
      signals.ariaLabel, signals.title,
    ].filter(Boolean);

    for (const p of parts) {
      for (const { unit, re } of UNIT_PATTERNS) {
        if (re.test(p)) return unit;
      }
    }

    // maxlength=4 且是数字，八成是年
    if (el.maxLength === 4) return 'Y';
    if (el.maxLength === 2) return null; // 月日都是 2，无法区分

    // 选项全是四位数字 → 年份下拉
    if (el.tagName === 'SELECT') {
      const opts = Array.from(el.options).filter((o) => o.value !== '');
      if (opts.length >= 5) {
        const numeric = opts.every((o) => /^\d{4}$/.test(o.textContent.trim()));
        if (numeric) return 'Y';
        const months = opts.every((o) => /^\d{1,2}$/.test(o.textContent.trim()) && +o.value >= 1 && +o.value <= 12);
        if (months && opts.length <= 12) return 'M';
        const days = opts.every((o) => /^\d{1,2}$/.test(o.textContent.trim()) && +o.value >= 1 && +o.value <= 31);
        if (days && opts.length >= 28) return 'D';
      }
    }
    return null;
  }

  /**
   * 检测以 el 为首的拆分日期控件组。
   * 返回 null 表示不是拆分日期。
   */
  function detectDateCluster(el, signals) {
    const container = S.formItemContainer(el) || el.parentElement;
    if (!container) return null;

    const controls = Array.from(container.querySelectorAll('input:not([type=hidden]),select'))
      .filter((c) => !c.disabled && !c.readOnly);
    if (controls.length < 2 || controls.length > 3) return null;
    if (controls[0] !== el) return null; // 只从组里第一个控件发起检测

    const units = [];
    for (const c of controls) {
      const sig = c === el ? signals : S.collectSignals(c);
      const u = inferUnit(c, sig);
      units.push({ el: c, unit: u, signals: sig });
    }

    // 位置兜底：2 个控件默认 年+月，3 个默认 年+月+日
    const unknownCount = units.filter((u) => !u.unit).length;
    if (unknownCount > 0) {
      const fallback = units.length === 2 ? ['Y', 'M'] : ['Y', 'M', 'D'];
      let fi = 0;
      for (const u of units) {
        if (!u.unit) u.unit = fallback[fi];
        fi++;
      }
    }

    // 单元必须互不重复，否则说明推断失败，宁可放弃也不要填错
    const seen = new Set();
    for (const u of units) {
      if (seen.has(u.unit)) return null;
      seen.add(u.unit);
    }
    if (!seen.has('Y')) return null;

    return {
      units,
      container,
      overallLabel: signals.labelText || (units.find((u) => u.signals.labelText) || {}).signals?.labelText || '',
    };
  }

  // ─────────────────────── 对整批字段做区块标注 ───────────────────────

  /**
   * 主入口：给描述符数组补上 .section 信息。
   * 返回 { descriptors, sectionRoots }
   */
  function annotate(descriptors) {
    // 先做一遍标题回溯，拿到每个字段的区块和区块根
    for (const d of descriptors) {
      const found = findSectionTitle(d.el);
      if (found) {
        d.section = { key: found.key, title: found.text, confidence: 0.9, rootEl: found.el };
        // 区块根：从字段往上找第一个包含该标题元素的祖先
        let anc = d.el;
        while (anc && anc !== document.body) {
          if (anc.contains(found.el) || anc.previousElementSibling === found.el ||
              (anc.parentElement && Array.from(anc.parentElement.children).includes(found.el))) {
            d.section.rootEl = anc.parentElement || anc;
            break;
          }
          anc = anc.parentElement;
        }
      } else {
        d.section = { key: null, title: '', confidence: 0, rootEl: null };
      }
    }

    // 标题找不到时，用「同容器里的邻居字段投票」来推断区块。
    // 很多 Element UI 站点的区块根本没有标题，只有一个空 div 包着。
    const byContainer = new Map();
    for (const d of descriptors) {
      const c = S.formItemContainer(d.el);
      if (!c) continue;
      if (!byContainer.has(c)) byContainer.set(c, []);
      byContainer.get(c).push(d);
    }

    for (const [container, group] of byContainer) {
      const unknown = group.filter((d) => !d.section.key);
      if (!unknown.length) continue;
      const votes = {};
      for (const d of group) {
        if (!d.section.key) continue;
        votes[d.section.key] = (votes[d.section.key] || 0) + 1;
      }
      const winner = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
      if (!winner) continue;
      for (const d of unknown) {
        d.section = { key: winner[0], title: '', confidence: 0.45, rootEl: null };
      }
    }

    // 重复块：给经历类字段标上它是第几条
    const counters = Object.create(null);
    for (const d of descriptors) {
      const k = d.section.key;
      if (!k || !F.REPEATING_SECTIONS.includes(k)) continue;

      const entry = findEntryContainer(d.el, d.section.rootEl);
      if (entry) {
        d.section.entryIndex = entry.index;
        d.section.entryEl = entry.entryEl;
        d.section.entryCount = entry.count;
        d.section.isRepeating = true;
      } else {
        // 没有明显的重复结构：按该区块在文档中出现的第几次来编号
        counters[k] = (counters[k] || 0) + 1;
        d.section.entryIndex = 0;
        d.section.isRepeating = false;
      }
    }

    // 拆分日期：把「被识别为日期组第一个控件」的描述符升级成 date-cluster，
    // 组里剩下的控件标记为已消费，不再单独参与匹配——否则年月日会被当成三个独立字段。
    for (const d of descriptors) {
      if (d.kind !== 'text' && d.kind !== 'select') continue;
      const cluster = detectDateCluster(d.el, d.signals);
      if (cluster) {
        d.kind = 'date-cluster';
        d.cluster = cluster;
      }
    }
    const inCluster = new Set();
    for (const d of descriptors) {
      if (d.kind !== 'date-cluster') continue;
      for (const u of d.cluster.units) {
        if (u.el !== d.el) inCluster.add(u.el);
      }
    }
    for (const d of descriptors) {
      if (inCluster.has(d.el)) d.consumed = true;
    }

    return descriptors;
  }

  RA.section = {
    annotate,
    findSectionTitle,
    classifySectionKind,
    findEntryContainer,
    findAddButton,
    detectDateCluster,
    inferUnit,
    looksLikeFieldLabel,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
